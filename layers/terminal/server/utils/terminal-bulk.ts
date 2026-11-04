// The bulk feed: every export table as a gzipped CSV in R2, rebuilt once a
// UTC day, with a manifest a client syncs from (GET /export/bulk/manifest.json).
//
// Two files per table. `recent` is what /export/<table>.csv serves by default
// (the trailing LICENSE_WINDOW_DAYS, CC BY 4.0), and it's what an anonymous
// caller's manifest lists. `full` is every row, labeled per row with its
// license, the older ones PAID_LICENSE: only a licensee's key sees it.
//
// Built by a cron (tasks/bulk/build.ts), not on request. A request for a file
// is then one R2 read and no D1 at all, however many licensees sync, and each
// file has a SHA-256 and a build time a client can compare before it
// downloads. The build is resumable. Each run builds the files not yet built
// today, until BUILD_BUDGET_MS is spent, and the hourly cron picks up the
// rest. A table whose build throws keeps yesterday's file, and the next run
// retries it.
//
// Sizes, checked 2026-11-04 on /api/coverage: the biggest table is snapshots
// at ~61k rows, under 2 MB gzipped. A file is assembled in memory before its
// one put, which is fine at that size for years. A table that ever outgrows
// that needs R2's multipart upload here.

import { HISTORY_LICENSE, PAID_LICENSE, licenseWindowStart } from '#shared/utils/license'

import type { PipelineDb } from '../pipeline/store'
import { SCHEMA_VERSION } from './data-schema'
import {
  EXPORT_TABLES,
  LICENSE_COLUMN,
  csvChunks,
  licenseWindow,
  streamOf,
  type ExportTable,
} from './terminal-export'

export const BULK_VARIANTS = ['recent', 'full'] as const
export type BulkVariant = (typeof BULK_VARIANTS)[number]

export const BULK_INDEX_PATH = 'bulk/index.json'
export const BULK_FORMAT = 'csv.gz'
const BUILD_BUDGET_MS = 20_000

export const bulkPath = (variant: BulkVariant, table: string) =>
  `bulk/${variant}/${table}.${BULK_FORMAT}`

export interface BulkFile {
  table: string
  variant: BulkVariant
  /** Rows in the file, not counting the header. */
  rows: number
  /** Size of the gzipped file. */
  bytes: number
  /** SHA-256 (hex) of the gzipped file, which is also its ETag. */
  sha256: string
  generated_at: string
  schema_version: string
  columns: string[]
  /** The license every row carries, or null when the license column labels each row. */
  license: string | null
  /** The first day the recent window keeps, or null for a file with every row. */
  from: string | null
}

export interface BulkIndex {
  files: Record<string, BulkFile>
}

/** The slice of NuxtHub's blob store the feed uses, so tests pass a Map-backed fake. */
export interface BulkStore {
  put(
    pathname: string,
    body: string | Uint8Array,
    options?: { contentType?: string },
  ): Promise<unknown>
  get(pathname: string): Promise<Blob | null>
}

const indexKey = (variant: BulkVariant, table: string) => `${variant}/${table}`

export async function readBulkIndex(store: BulkStore): Promise<BulkIndex> {
  const body = await store.get(BULK_INDEX_PATH)
  if (!body) return { files: {} }
  try {
    const parsed = JSON.parse(await body.text()) as Partial<BulkIndex>
    return { files: parsed.files ?? {} }
  } catch {
    return { files: {} }
  }
}

/**
 * The table as a bulk file of `variant` serves it: the license window applied
 * as /export does, with PAID_LICENSE on older rows, since only a key reads
 * `full`.
 */
export function bulkTable(
  name: string,
  table: ExportTable,
  variant: BulkVariant,
  from: string,
): { table: ExportTable; license: string | null; from: string | null } {
  const window = licenseWindow(
    name,
    table,
    variant === 'full' ? { history: 'full' } : {},
    from,
    variant === 'full' ? PAID_LICENSE : HISTORY_LICENSE,
  )
  return {
    table: window.table,
    license: window.split ? null : 'CC-BY-4.0',
    from: window.windowed ? from : null,
  }
}

/** The gzipped CSV of `table`, with its row count and SHA-256. */
export async function gzipCsv(
  db: PipelineDb,
  table: ExportTable,
): Promise<{ body: Uint8Array; rows: number; sha256: string }> {
  // Counted off the pages: a quoted cell can hold a line break, so lines aren't rows.
  let rows = 0
  const counted: ExportTable = {
    ...table,
    async page(...args) {
      const page = await table.page(...args)
      rows += page.length
      return page
    },
  }
  const text = streamOf(csvChunks(db, counted))
  const body = new Uint8Array(
    await new Response(
      // DOM's lib types CompressionStream's writable side as BufferSource,
      // which pipeThrough's Uint8Array pair won't take. Same stream at runtime.
      text.pipeThrough(
        new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
      ),
    ).arrayBuffer(),
  )
  const digest = await crypto.subtle.digest('SHA-256', body)
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return { body, rows, sha256 }
}

export interface BulkBuildReport {
  built: string[]
  failed: { file: string; error: string }[]
  /** Files left for the next run because the budget ran out. */
  deferred: string[]
}

/**
 * Build every file not yet built today (UTC) or built under an older schema,
 * until the time budget is spent. Writes each file, then the index once.
 */
export async function runBulkBuild(deps: {
  db: PipelineDb
  store: BulkStore
  now?: () => Date
  budgetMs?: number
  tables?: Readonly<Record<string, ExportTable>>
}): Promise<BulkBuildReport> {
  const now = deps.now ?? (() => new Date())
  const start = now()
  const budget = deps.budgetMs ?? BUILD_BUDGET_MS
  const today = start.toISOString().slice(0, 10)
  const from = licenseWindowStart(start)
  const index = await readBulkIndex(deps.store)
  const report: BulkBuildReport = { built: [], failed: [], deferred: [] }

  for (const [name, table] of Object.entries(deps.tables ?? EXPORT_TABLES)) {
    for (const variant of BULK_VARIANTS) {
      const key = indexKey(variant, name)
      const existing = index.files[key]
      if (
        existing &&
        existing.generated_at.slice(0, 10) === today &&
        existing.schema_version === SCHEMA_VERSION
      ) {
        continue
      }
      if (now().getTime() - start.getTime() > budget) {
        report.deferred.push(key)
        continue
      }
      try {
        const cut = bulkTable(name, table, variant, from)
        const { body, rows, sha256 } = await gzipCsv(deps.db, cut.table)
        await deps.store.put(bulkPath(variant, name), body, { contentType: 'application/gzip' })
        index.files[key] = {
          table: name,
          variant,
          rows,
          bytes: body.byteLength,
          sha256,
          generated_at: start.toISOString(),
          schema_version: SCHEMA_VERSION,
          columns: [...cut.table.columns],
          license: cut.license,
          from: cut.from,
        }
        report.built.push(key)
      } catch (error) {
        report.failed.push({ file: key, error: String(error) })
      }
    }
  }
  // A table no longer exported drops out of the index (its file stays in R2, unlisted).
  for (const key of Object.keys(index.files)) {
    if (!(index.files[key]!.table in (deps.tables ?? EXPORT_TABLES))) delete index.files[key]
  }
  if (report.built.length) {
    await deps.store.put(BULK_INDEX_PATH, JSON.stringify(index), {
      contentType: 'application/json',
    })
  }
  return report
}

export interface BulkManifestEntry {
  table: string
  url: string
  format: typeof BULK_FORMAT
  rows: number
  bytes: number
  sha256: string
  generated_at: string
  schema_version: string
  columns: string[]
  license: string | null
  license_column: string | null
  from: string | null
}

export interface BulkManifest {
  schema_version: string
  history: BulkVariant
  generated_at: string | null
  /** The license the files carry, and where a row's own label is. */
  license: { recent: string; older: string | null; terms: string; note: string }
  tables: BulkManifestEntry[]
}

/** What a caller's manifest lists: `recent` files for anonymous, `full` for a key. */
export function bulkManifest(index: BulkIndex, variant: BulkVariant, appUrl: string): BulkManifest {
  const files = Object.values(index.files)
    .filter((f) => f.variant === variant)
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
  return {
    schema_version: SCHEMA_VERSION,
    history: variant,
    generated_at: files.reduce<string | null>(
      (max, f) => (max === null || f.generated_at > max ? f.generated_at : max),
      null,
    ),
    license:
      variant === 'full'
        ? {
            recent: 'CC-BY-4.0',
            older: PAID_LICENSE.id,
            terms: PAID_LICENSE.url,
            note: `Every row, labeled in the ${LICENSE_COLUMN} column where a table has history. Rows older than the trailing window are licensed to the holder of this key under the ${PAID_LICENSE.short}.`,
          }
        : {
            recent: 'CC-BY-4.0',
            older: null,
            terms: '/license',
            note: `The trailing window of each table that grows (from), and every row of the rest, all CC BY 4.0. Full history needs an API key, or /export/<table>.csv?history=full under ${HISTORY_LICENSE.short}.`,
          },
    tables: files.map((f) => ({
      table: f.table,
      url: `${appUrl}/export/${bulkPath(variant, f.table)}`,
      format: BULK_FORMAT,
      rows: f.rows,
      bytes: f.bytes,
      sha256: f.sha256,
      generated_at: f.generated_at,
      schema_version: f.schema_version,
      columns: f.columns,
      license: f.license,
      license_column: f.license === null ? LICENSE_COLUMN : null,
      from: f.from,
    })),
  }
}

/** The file a `/export/bulk/<variant>/<file>` path names, or null. */
export function bulkFileOf(
  index: BulkIndex,
  variant: string | undefined,
  file: string | undefined,
): BulkFile | null {
  if (!(BULK_VARIANTS as readonly string[]).includes(variant ?? '')) return null
  const table = file?.endsWith(`.${BULK_FORMAT}`) ? file.slice(0, -BULK_FORMAT.length - 1) : null
  if (!table) return null
  return index.files[indexKey(variant as BulkVariant, table)] ?? null
}

/**
 * Whether a conditional request already has this representation: an
 * If-None-Match naming `etag`, or failing that an If-Modified-Since at or
 * after `modified`.
 */
export function notModified(
  ifNoneMatch: string | undefined,
  ifModifiedSince: string | undefined,
  etag: string,
  modified: string | null,
): boolean {
  if (ifNoneMatch !== undefined) return ifNoneMatch.split(',').some((t) => t.trim() === etag)
  const since = Date.parse(ifModifiedSince ?? '')
  // An HTTP date has whole seconds and the build time has milliseconds.
  return modified !== null && !Number.isNaN(since) && Date.parse(modified) - 999 <= since
}
