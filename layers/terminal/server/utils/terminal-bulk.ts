// The bulk feed: every export table as a gzipped CSV and as a Parquet file in
// R2, rebuilt once a UTC day, with a manifest a client syncs from
// (GET /export/bulk/manifest.json).
//
// Two cuts per table. `recent` is what /export/<table>.csv serves by default
// (the trailing LICENSE_WINDOW_DAYS, CC BY 4.0), and it's what an anonymous
// caller's manifest lists. `full` is every row, labeled per row with its
// license, the older ones PAID_LICENSE: only a licensee's key sees it. Each
// cut is written in both formats from one pass over the table.
//
// The `full` files are also copied to a second bucket that holds nothing else
// (LICENSED_BUCKET), with a manifest of their own. A licensee's S3 credentials
// are scoped to that bucket, read-only (scripts/bulk-grant.ts), so S3 access can
// never reach the raw payloads or anything anonymous callers can't see either.
//
// Built by a cron (tasks/bulk/build.ts), not on request. A request for a file
// is then one R2 read and no D1 at all, however many licensees sync, and each
// file has a SHA-256 and a build time a client can compare before it
// downloads. The build is resumable. Each run builds the cuts not yet built
// today, until BUILD_BUDGET_MS is spent, and the hourly cron picks up the
// rest. A table whose build throws keeps yesterday's files, and the next run
// retries it.
//
// Sizes, checked 2026-11-04 on the production feed: the biggest table is
// snapshots at ~61k rows, 2.2 MB gzipped and about as much again as Parquet.
// Both files are assembled in memory before their puts; the Parquet writer
// holds one row group of decoded rows at a time (terminal-parquet.ts). A table
// that ever outgrows that needs R2's multipart upload here.

import {
  DATA_LICENSE,
  HISTORY_LICENSE,
  PAID_LICENSE,
  licenseWindowStart,
  type LicenseRef,
} from '#shared/utils/license'

import { LICENSED_BUCKET } from '../../shared/utils/institutional'
import type { PipelineDb } from '../pipeline/store'
import { SCHEMA_VERSION } from './data-schema'
import {
  ARCHIVED_EXPORTS,
  EXPORT_TABLES,
  LICENSE_COLUMN,
  csvLine,
  exportPages,
  licenseWindow,
  type ExportTable,
} from './terminal-export'
import { parquetBuilder } from './terminal-parquet'

export const BULK_VARIANTS = ['recent', 'full'] as const
export type BulkVariant = (typeof BULK_VARIANTS)[number]

export const BULK_FORMATS = ['csv.gz', 'parquet'] as const
export type BulkFormat = (typeof BULK_FORMATS)[number]

export const BULK_CONTENT_TYPES: Readonly<Record<BulkFormat, string>> = {
  'csv.gz': 'application/gzip',
  parquet: 'application/vnd.apache.parquet',
}

export const BULK_INDEX_PATH = 'bulk/index.json'
const BUILD_BUDGET_MS = 20_000

export const bulkPath = (variant: BulkVariant, table: string, format: BulkFormat) =>
  `bulk/${variant}/${table}.${format}`

/** LICENSED_BUCKET's binding in wrangler.toml. The bucket holds the `full` files and their manifest, nothing else. */
export const LICENSED_BINDING = 'BULK_LICENSED'
/** A `full` file's object key in LICENSED_BUCKET. */
export const licensedKey = (table: string, format: BulkFormat) => `full/${table}.${format}`
export const LICENSED_MANIFEST_KEY = 'manifest.json'

export interface BulkFile {
  table: string
  variant: BulkVariant
  format: BulkFormat
  /** Rows in the file, not counting a CSV's header. */
  rows: number
  /** Size of the file as stored. */
  bytes: number
  /** SHA-256 (hex) of the stored file, which is also its ETag. */
  sha256: string
  generated_at: string
  schema_version: string
  columns: string[]
  /** The license every row carries, or null when the license column labels each row. */
  license: string | null
  /** What the license column labels rows older than the window, or null when it isn't there. */
  license_older: string | null
  /** The first day the recent window keeps, or null for a file with every row. */
  from: string | null
  /** A `full` file that is also in LICENSED_BUCKET. */
  licensed_copy?: boolean
}

export interface BulkIndex {
  files: Record<string, BulkFile>
}

/** The slice of NuxtHub's blob store the feed uses, so tests pass a Map-backed fake. */
export interface BulkStore {
  put(
    pathname: string,
    body: string | Uint8Array,
    options?: { contentType?: string; sha256?: string },
  ): Promise<unknown>
  get(pathname: string): Promise<Blob | null>
}

/** Where the `full` files are copied for S3 access. Only written to. */
export type LicensedStore = Pick<BulkStore, 'put'>

/** The R2 binding's put, as much of it as the copy uses. */
interface R2PutBinding {
  put(
    key: string,
    value: string | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
      sha256?: string
    },
  ): Promise<unknown>
}

/**
 * LICENSED_BINDING off the Worker env, or null when this Worker has no such
 * binding (local dev, tests, or a deploy before the bucket exists). R2 checks
 * each put against its SHA-256, and S3 clients see it as x-amz-meta-sha256.
 */
export function licensedStoreOf(env: unknown): LicensedStore | null {
  const binding = (env as Record<string, unknown> | null | undefined)?.[LICENSED_BINDING]
  if (typeof (binding as R2PutBinding | undefined)?.put !== 'function') return null
  const bucket = binding as R2PutBinding
  return {
    put: (key, body, options) =>
      bucket.put(key, body, {
        httpMetadata: { contentType: options?.contentType },
        ...(options?.sha256
          ? { sha256: options.sha256, customMetadata: { sha256: options.sha256 } }
          : {}),
      }),
  }
}

const indexKey = (variant: BulkVariant, table: string, format: BulkFormat) =>
  `${variant}/${table}.${format}`

export async function readBulkIndex(store: BulkStore): Promise<BulkIndex> {
  const body = await store.get(BULK_INDEX_PATH)
  if (!body) return { files: {} }
  try {
    const parsed = JSON.parse(await body.text()) as Partial<BulkIndex>
    const files: Record<string, BulkFile> = {}
    for (const f of Object.values(parsed.files ?? {})) {
      // An entry from before Parquet was a CSV keyed `<variant>/<table>`. Its
      // file is still at the same path, so it keeps being served until the
      // next build replaces it.
      const file: BulkFile = {
        ...f,
        format: f.format ?? 'csv.gz',
        license_older: f.license_older ?? null,
      }
      files[indexKey(file.variant, file.table, file.format)] = file
    }
    return { files }
  } catch {
    return { files: {} }
  }
}

/**
 * The table as a bulk file of `variant` serves it: the license window applied
 * as /export does, with PAID_LICENSE on older rows, since only a key reads
 * `full`. The archived tables keep HISTORY_LICENSE on theirs (licenseWindow).
 */
export function bulkTable(
  name: string,
  table: ExportTable,
  variant: BulkVariant,
  from: string,
): { table: ExportTable; license: string | null; older: LicenseRef | null; from: string | null } {
  const window = licenseWindow(
    name,
    table,
    variant === 'full' ? { history: 'full' } : {},
    from,
    variant === 'full' ? PAID_LICENSE : HISTORY_LICENSE,
  )
  return {
    table: window.table,
    license: window.split ? null : DATA_LICENSE.id,
    older: window.split ? window.older : null,
    from: window.windowed ? from : null,
  }
}

export interface BuiltFile {
  body: Uint8Array<ArrayBuffer>
  rows: number
  sha256: string
}

async function sha256Of(body: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * `table` as a gzipped CSV and a Parquet file, from one pass over its pages.
 * `meta` is the Parquet file's key-value metadata (terminal-parquet.ts).
 */
export async function bulkFiles(
  db: PipelineDb,
  table: ExportTable,
  meta: Readonly<Record<string, string>>,
): Promise<Record<BulkFormat, BuiltFile>> {
  const gzip = new CompressionStream('gzip')
  // DOM's lib types CompressionStream's writable side as BufferSource, which
  // a Uint8Array writer won't take. Same stream at runtime.
  const gzipped = new Response(gzip.readable as ReadableStream<Uint8Array>).arrayBuffer()
  const csv = (gzip.writable as WritableStream<Uint8Array>).getWriter()
  const encoder = new TextEncoder()
  const parquet = parquetBuilder(table, meta)
  // Counted off the pages: a quoted cell can hold a line break, so lines aren't rows.
  let rows = 0
  try {
    await csv.write(encoder.encode(csvLine(table.columns)))
    for await (const page of exportPages(db, table)) {
      rows += page.length
      await csv.write(
        encoder.encode(page.map((row) => csvLine(table.columns.map((c) => row[c]))).join('')),
      )
      parquet.add(page)
    }
    await csv.close()
  } catch (error) {
    await csv.abort(error).catch(() => {})
    await gzipped.catch(() => {})
    throw error
  }
  const csvBody = new Uint8Array(await gzipped)
  const parquetFile = parquet.finish()
  return {
    'csv.gz': { body: csvBody, rows, sha256: await sha256Of(csvBody) },
    parquet: { ...parquetFile, sha256: await sha256Of(parquetFile.body) },
  }
}

/** What a Parquet file says about itself, in its key-value metadata. */
export function parquetMeta(
  name: string,
  variant: BulkVariant,
  cut: ReturnType<typeof bulkTable>,
  generatedAt: string,
): Record<string, string> {
  return {
    table: name,
    history: variant,
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    license: cut.license ?? `per row, in the ${LICENSE_COLUMN} column`,
    license_recent: DATA_LICENSE.id,
    ...(cut.older ? { license_older: cut.older.id, license_older_terms: cut.older.url } : {}),
    ...(cut.from ? { from: cut.from } : {}),
    provenance: 'Every row carries source_url and fetched_at (or started_at, or checked_on).',
    dictionary: '/export/dictionary.json',
  }
}

export interface BulkBuildReport {
  /** `<variant>/<table>`: each cut built is both its files. */
  built: string[]
  failed: { file: string; error: string }[]
  /** Cuts left for the next run because the budget ran out. */
  deferred: string[]
}

/** Whether `variant`'s cut of `table` is already built today, under this schema, everywhere it goes. */
function isCurrent(
  index: BulkIndex,
  variant: BulkVariant,
  table: string,
  today: string,
  licensed: boolean,
): boolean {
  return BULK_FORMATS.every((format) => {
    const f = index.files[indexKey(variant, table, format)]
    return (
      f !== undefined &&
      f.generated_at.slice(0, 10) === today &&
      f.schema_version === SCHEMA_VERSION &&
      (variant !== 'full' || !licensed || f.licensed_copy === true)
    )
  })
}

/**
 * Build every cut not yet built today (UTC), built under an older schema, or
 * (with `licensed`) not yet copied there, until the time budget is spent.
 * Writes each cut's files, then the index once, then the licensed bucket's
 * manifest when a `full` cut changed.
 */
export async function runBulkBuild(deps: {
  db: PipelineDb
  store: BulkStore
  licensed?: LicensedStore | null
  /** For the licensed bucket's manifest URLs. */
  appUrl?: string
  now?: () => Date
  budgetMs?: number
  tables?: Readonly<Record<string, ExportTable>>
}): Promise<BulkBuildReport> {
  const now = deps.now ?? (() => new Date())
  const start = now()
  const budget = deps.budgetMs ?? BUILD_BUDGET_MS
  const today = start.toISOString().slice(0, 10)
  const from = licenseWindowStart(start)
  const tables = deps.tables ?? EXPORT_TABLES
  const licensed = deps.licensed ?? null
  const index = await readBulkIndex(deps.store)
  const report: BulkBuildReport = { built: [], failed: [], deferred: [] }

  for (const [name, table] of Object.entries(tables)) {
    for (const variant of BULK_VARIANTS) {
      const key = `${variant}/${name}`
      if (isCurrent(index, variant, name, today, licensed !== null)) continue
      if (now().getTime() - start.getTime() > budget) {
        report.deferred.push(key)
        continue
      }
      try {
        const cut = bulkTable(name, table, variant, from)
        const generatedAt = start.toISOString()
        const files = await bulkFiles(
          deps.db,
          cut.table,
          parquetMeta(name, variant, cut, generatedAt),
        )
        for (const format of BULK_FORMATS) {
          const { body, sha256 } = files[format]
          const contentType = BULK_CONTENT_TYPES[format]
          await deps.store.put(bulkPath(variant, name, format), body, { contentType })
          if (variant === 'full' && licensed) {
            await licensed.put(licensedKey(name, format), body, { contentType, sha256 })
          }
        }
        for (const format of BULK_FORMATS) {
          const { body, rows, sha256 } = files[format]
          index.files[indexKey(variant, name, format)] = {
            table: name,
            variant,
            format,
            rows,
            bytes: body.byteLength,
            sha256,
            generated_at: generatedAt,
            schema_version: SCHEMA_VERSION,
            columns: [...cut.table.columns],
            license: cut.license,
            license_older: cut.older?.id ?? null,
            from: cut.from,
            ...(variant === 'full' ? { licensed_copy: licensed !== null } : {}),
          }
        }
        report.built.push(key)
      } catch (error) {
        report.failed.push({ file: key, error: String(error) })
      }
    }
  }
  // A table no longer exported drops out of the index (its files stay in R2, unlisted).
  for (const key of Object.keys(index.files)) {
    if (!(index.files[key]!.table in tables)) delete index.files[key]
  }
  if (report.built.length) {
    await deps.store.put(BULK_INDEX_PATH, JSON.stringify(index), {
      contentType: 'application/json',
    })
  }
  if (licensed && report.built.some((key) => key.startsWith('full/'))) {
    const manifest = bulkManifest(index, 'full', deps.appUrl ?? '')
    await licensed.put(LICENSED_MANIFEST_KEY, JSON.stringify(manifest, null, 2), {
      contentType: 'application/json',
    })
  }
  return report
}

/** One file of a manifest entry. */
export interface BulkManifestFile {
  url: string
  format: BulkFormat
  rows: number
  bytes: number
  sha256: string
  generated_at: string
  schema_version: string
  /** The object's key in LICENSED_BUCKET, for S3 access. Null for a `recent` file. */
  s3_key: string | null
}

export interface BulkManifestEntry extends BulkManifestFile {
  table: string
  format: 'csv.gz'
  columns: string[]
  license: string | null
  license_column: string | null
  /** What the license column labels rows older than the window with. */
  license_older: string | null
  from: string | null
  /** The same rows and columns as Parquet, typed by the data dictionary. */
  parquet: BulkManifestFile | null
}

export interface BulkManifest {
  schema_version: string
  history: BulkVariant
  generated_at: string | null
  /** The license the files carry, and where a row's own label is. */
  license: { recent: string; older: string | null; terms: string; note: string }
  /** Where a licensee reads the same `full` files over S3, or null for `recent`. */
  s3: { bucket: string; prefix: string; manifest: string; credentials: string } | null
  tables: BulkManifestEntry[]
}

const ARCHIVED_LIST = [...ARCHIVED_EXPORTS].join(' and ')

function manifestFile(f: BulkFile, appUrl: string): BulkManifestFile {
  return {
    url: `${appUrl}/export/${bulkPath(f.variant, f.table, f.format)}`,
    format: f.format,
    rows: f.rows,
    bytes: f.bytes,
    sha256: f.sha256,
    generated_at: f.generated_at,
    schema_version: f.schema_version,
    s3_key: f.variant === 'full' ? licensedKey(f.table, f.format) : null,
  }
}

/** What a caller's manifest lists: `recent` files for anonymous, `full` for a key. */
export function bulkManifest(index: BulkIndex, variant: BulkVariant, appUrl: string): BulkManifest {
  const csvs = Object.values(index.files)
    .filter((f) => f.variant === variant && f.format === 'csv.gz')
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
  const files = Object.values(index.files).filter((f) => f.variant === variant)
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
            recent: DATA_LICENSE.id,
            older: PAID_LICENSE.id,
            terms: PAID_LICENSE.url,
            note: `Every row, labeled in the ${LICENSE_COLUMN} column where a table has history. Rows older than the trailing window are licensed to the holder of this key under the ${PAID_LICENSE.short}, except ${ARCHIVED_LIST}, read from the Internet Archive, whose older rows stay ${HISTORY_LICENSE.short}.`,
          }
        : {
            recent: DATA_LICENSE.id,
            older: null,
            terms: '/license',
            note: `The trailing window of each table that grows (from), and every row of the rest, all CC BY 4.0. Full history needs an API key, or /export/<table>.csv?history=full under ${HISTORY_LICENSE.short}.`,
          },
    s3:
      variant === 'full'
        ? {
            bucket: LICENSED_BUCKET,
            prefix: 'full/',
            manifest: LICENSED_MANIFEST_KEY,
            credentials:
              'Read-only S3 credentials for this bucket are issued per licensee by email, with the endpoint (/data#institutions).',
          }
        : null,
    tables: csvs.map((f) => {
      const parquet = index.files[indexKey(f.variant, f.table, 'parquet')]
      return {
        ...manifestFile(f, appUrl),
        table: f.table,
        format: 'csv.gz',
        columns: f.columns,
        license: f.license,
        license_column: f.license === null ? LICENSE_COLUMN : null,
        license_older: f.license_older ?? null,
        from: f.from,
        parquet: parquet ? manifestFile(parquet, appUrl) : null,
      }
    }),
  }
}

/** The file a `/export/bulk/<variant>/<file>` path names, or null. */
export function bulkFileOf(
  index: BulkIndex,
  variant: string | undefined,
  file: string | undefined,
): BulkFile | null {
  if (!(BULK_VARIANTS as readonly string[]).includes(variant ?? '')) return null
  const format = BULK_FORMATS.find((f) => file?.endsWith(`.${f}`))
  if (!format || !file) return null
  const table = file.slice(0, -format.length - 1)
  if (!table) return null
  return index.files[indexKey(variant as BulkVariant, table, format)] ?? null
}

/**
 * The one byte range a `Range` header asks for, inclusive, clamped to `size`:
 * null for no header or one this doesn't serve (several ranges, another unit),
 * which gets the whole file, and 'unsatisfiable' for a range past the end.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!match || (match[1] === '' && match[2] === '')) return null
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
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
