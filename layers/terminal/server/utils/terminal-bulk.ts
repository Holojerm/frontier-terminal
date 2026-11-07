// The bulk feed: every export table as a gzipped CSV and as a Parquet file in
// R2, rebuilt once a UTC day, with a manifest a client syncs from
// (GET /export/bulk/manifest.json).
//
// Two cuts per table. `recent` is what /export/<table>.csv serves by default
// (the trailing LICENSE_WINDOW_DAYS, CC BY 4.0), and it's what an anonymous
// caller's manifest lists. `full` is every row, labeled per row with its
// license, the older ones PAID_LICENSE: only a licensee's key sees it. Both
// cuts, in both formats, come from one pass over the table: `recent` is the
// `full` rows dated inside the window, without the license column. A table
// that isn't cut by age is the same in both, so it is written once and both
// index entries name that one file.
//
// The `full` files live in a second bucket that holds nothing else
// (LICENSED_BUCKET), with a manifest of their own, and /export/bulk/full/*
// serves them from there. A licensee's S3 credentials are scoped to that
// bucket, read-only (scripts/bulk-grant.ts), so S3 access can never reach the
// raw payloads or anything anonymous callers can't see either. A Worker
// without the binding (local dev, tests) keeps them in the blob store.
//
// Built by a cron (tasks/bulk/build.ts), not on request. A request for a file
// is then one R2 read and no D1 at all, however many licensees sync, and each
// file has a SHA-256 and a build time a client can compare before it
// downloads. The build is resumable. Each run builds the cuts not yet built
// today, smallest first, until BUILD_BUDGET_MS is spent, and saves the index
// after every cut, so nothing built is lost if the run is cut short. A cut
// that failed today goes to the back of the queue, so one table that keeps
// failing can't hold up the rest. It keeps yesterday's files meanwhile.
//
// A schema release only rebuilds the tables it changes (isCurrent). The rest
// keep today's files, which state the schema version they were built under.
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
import { SCHEMA_VERSION, tableChangedAfter } from './data-schema'
import {
  ARCHIVED_EXPORTS,
  EXPORT_PAGE_SIZE,
  EXPORT_TABLES,
  LICENSE_COLUMN,
  csvLine,
  exportPages,
  historyRule,
  inWindow,
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

/**
 * Wall time a run may spend starting cuts. An hourly cron may run for 15
 * minutes, and the build waits on D1, not the CPU: on 2026-11-05 a run spent
 * 672 ms of CPU in 23.6 s of wall time. The old 20 s budget let one run build
 * about one table. The margin covers the cut in progress when this runs out.
 */
export const BUILD_BUDGET_MS = 8 * 60_000

/**
 * D1 queries a run may plan for. D1 refuses a Worker invocation's queries past
 * its per-invocation limit (1,000 on Workers Paid), so a run stops starting
 * cuts before it gets there and leaves the rest to the next. On 2026-11-05 a
 * full rebuild needed about 400.
 */
export const D1_READ_BUDGET = 800

/** The D1 reads a cut of `table` costs: its pages at its row count last time, plus the empty last read. */
export function d1Reads(index: BulkIndex, table: string): number {
  const rows = index.files[indexKey('full', table, 'csv.gz')]?.rows ?? 0
  return Math.ceil(rows / EXPORT_PAGE_SIZE) + 1
}

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
  /** Where the bytes are. A whole table's `recent` and `full` entries name the same object. */
  stored: StoredAt
}

export interface StoredAt {
  in: 'blob' | 'licensed'
  key: string
}

export interface BulkIndex {
  files: Record<string, BulkFile>
  /** Cuts (`<variant>/<table>`) whose last build failed, with when and why. Cleared by a success. */
  failures?: Record<string, { at: string; error: string }>
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

/** LICENSED_BUCKET, where the `full` files live for S3 access and /export/bulk/full/*. */
export type LicensedStore = BulkStore

/** The R2 binding, as much of it as the feed uses. */
interface R2Binding {
  get(key: string): Promise<{ blob(): Promise<Blob> } | null>
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
  if (typeof (binding as R2Binding | undefined)?.put !== 'function') return null
  const bucket = binding as R2Binding
  return {
    get: async (key) => (await bucket.get(key))?.blob() ?? null,
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

type LegacyBulkFile = Omit<BulkFile, 'format' | 'stored'> &
  Partial<Pick<BulkFile, 'format' | 'stored'>> & { licensed_copy?: boolean }

export async function readBulkIndex(store: BulkStore): Promise<BulkIndex> {
  const body = await store.get(BULK_INDEX_PATH)
  if (!body) return { files: {} }
  try {
    const parsed = JSON.parse(await body.text()) as Partial<BulkIndex>
    const files: Record<string, BulkFile> = {}
    // Failures were once keyed per cut (`<variant>/<table>`); a table builds both now.
    const failures = Object.fromEntries(
      Object.entries(parsed.failures ?? {}).filter(([key]) => !key.includes('/')),
    )
    for (const f of Object.values(parsed.files ?? {}) as LegacyBulkFile[]) {
      // An entry from before Parquet was a CSV keyed `<variant>/<table>`, and
      // one from before `stored` was in the blob store, its `full` files also
      // copied to LICENSED_BUCKET when licensed_copy says so. Those files are
      // still there, so they keep being served until the next build.
      const { licensed_copy, ...rest } = f
      const format = f.format ?? 'csv.gz'
      const file: BulkFile = {
        ...rest,
        format,
        license_older: f.license_older ?? null,
        stored:
          f.stored ??
          (licensed_copy
            ? { in: 'licensed', key: licensedKey(f.table, format) }
            : { in: 'blob', key: bulkPath(f.variant, f.table, format) }),
      }
      files[indexKey(file.variant, file.table, file.format)] = file
    }
    return { files, failures }
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

/** One file pair a pass writes: the rows of the pass that `keep` keeps, in `table`'s columns. */
export interface BulkSink {
  table: ExportTable
  /** The Parquet file's key-value metadata (parquetMeta). */
  meta: Readonly<Record<string, string>>
  keep?: (row: Record<string, unknown>) => boolean
}

/**
 * Each sink as a gzipped CSV and a Parquet file, all from one pass over
 * `source`'s pages. A sink's columns are a subset of the source's.
 */
export async function bulkFiles(
  db: PipelineDb,
  source: ExportTable,
  sinks: readonly BulkSink[],
): Promise<Record<BulkFormat, BuiltFile>[]> {
  const encoder = new TextEncoder()
  const open = sinks.map((sink) => {
    const gzip = new CompressionStream('gzip')
    return {
      sink,
      // DOM's lib types CompressionStream's writable side as BufferSource, which
      // a Uint8Array writer won't take. Same stream at runtime.
      gzipped: new Response(gzip.readable as ReadableStream<Uint8Array>).arrayBuffer(),
      csv: (gzip.writable as WritableStream<Uint8Array>).getWriter(),
      parquet: parquetBuilder(sink.table, sink.meta),
      // Counted off the pages: a quoted cell can hold a line break, so lines aren't rows.
      rows: 0,
    }
  })
  try {
    for (const o of open) await o.csv.write(encoder.encode(csvLine(o.sink.table.columns)))
    for await (const page of exportPages(db, source)) {
      for (const o of open) {
        const rows = o.sink.keep ? page.filter(o.sink.keep) : page
        if (!rows.length) continue
        o.rows += rows.length
        const { columns } = o.sink.table
        await o.csv.write(
          encoder.encode(rows.map((row) => csvLine(columns.map((c) => row[c]))).join('')),
        )
        o.parquet.add(rows)
      }
    }
    for (const o of open) await o.csv.close()
  } catch (error) {
    for (const o of open) {
      await o.csv.abort(error).catch(() => {})
      await o.gzipped.catch(() => {})
    }
    throw error
  }
  return Promise.all(
    open.map(async (o) => {
      const csvBody = new Uint8Array(await o.gzipped)
      const parquetFile = o.parquet.finish()
      return {
        'csv.gz': { body: csvBody, rows: o.rows, sha256: await sha256Of(csvBody) },
        parquet: { ...parquetFile, sha256: await sha256Of(parquetFile.body) },
      }
    }),
  )
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
  /** Tables built: both cuts, both formats. */
  built: string[]
  failed: { file: string; error: string }[]
  /** Tables left for the next run because the budget ran out. */
  deferred: string[]
}

/**
 * Whether `variant`'s cut of `table` is already built today, with the columns
 * it has now, and stored where it goes. A file built under an older schema
 * version still counts unless a release since then changed this table.
 */
export function isCurrent(
  index: BulkIndex,
  variant: BulkVariant,
  table: string,
  columns: readonly string[],
  today: string,
  licensed: boolean,
): boolean {
  return BULK_FORMATS.every((format) => {
    const f = index.files[indexKey(variant, table, format)]
    return (
      f !== undefined &&
      f.generated_at.slice(0, 10) === today &&
      !tableChangedAfter(table, f.schema_version) &&
      f.columns.length === columns.length &&
      f.columns.every((c, i) => c === columns[i]) &&
      (variant !== 'full' || !licensed || f.stored.in === 'licensed')
    )
  })
}

/**
 * The order a run builds its tables in: those that haven't failed today
 * first, then by how many rows they had last time, smallest (or never built)
 * first. So the cheap tables are done early, and a table that fails every
 * time is tried once, last, instead of first in every run.
 */
export function buildOrder(index: BulkIndex, tables: readonly string[], today: string): string[] {
  const failedToday = (table: string) => index.failures?.[table]?.at.slice(0, 10) === today
  const rows = (table: string) => index.files[indexKey('full', table, 'csv.gz')]?.rows ?? 0
  return [...tables].sort(
    (a, b) =>
      Number(failedToday(a)) - Number(failedToday(b)) ||
      rows(a) - rows(b) ||
      (a < b ? -1 : a > b ? 1 : 0),
  )
}

/**
 * Build every table isCurrent says isn't, in buildOrder, until the time
 * budget is spent. Saves the index after each table, then writes the licensed
 * bucket's manifest when anything was built.
 */
export async function runBulkBuild(deps: {
  db: PipelineDb
  store: BulkStore
  licensed?: LicensedStore | null
  /** For the licensed bucket's manifest URLs. */
  appUrl?: string
  now?: () => Date
  budgetMs?: number
  d1ReadBudget?: number
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
  const failures = (index.failures ??= {})
  const report: BulkBuildReport = { built: [], failed: [], deferred: [] }
  const saveIndex = () =>
    deps.store.put(BULK_INDEX_PATH, JSON.stringify(index), { contentType: 'application/json' })

  const cutsOf = (name: string, table: ExportTable) => ({
    recent: bulkTable(name, table, 'recent', from),
    full: bulkTable(name, table, 'full', from),
  })
  const due = Object.entries(tables)
    .filter(([name, table]) => {
      const cuts = cutsOf(name, table)
      return !BULK_VARIANTS.every((variant) =>
        isCurrent(index, variant, name, cuts[variant].table.columns, today, licensed !== null),
      )
    })
    .map(([name]) => name)
  // A table no longer exported drops out of the index (its files stay in R2, unlisted).
  for (const key of Object.keys(index.files)) {
    if (!(index.files[key]!.table in tables)) delete index.files[key]
  }

  let reads = 0
  for (const name of buildOrder(index, due, today)) {
    const cost = d1Reads(index, name)
    const overReads = reads > 0 && reads + cost > (deps.d1ReadBudget ?? D1_READ_BUDGET)
    if (now().getTime() - start.getTime() > budget || overReads) {
      report.deferred.push(name)
      continue
    }
    reads += cost
    try {
      const generatedAt = start.toISOString()
      const cuts = cutsOf(name, tables[name]!)
      const rule = historyRule(name)
      const sink = (variant: BulkVariant): BulkSink => ({
        table: cuts[variant].table,
        meta: parquetMeta(name, variant, cuts[variant], generatedAt),
      })
      // A whole table's two cuts are the same rows: one file pair serves both.
      const [full, recent = full] = await bulkFiles(
        deps.db,
        cuts.full.table,
        rule.kind === 'whole'
          ? [sink('full')]
          : [sink('full'), { ...sink('recent'), keep: (row) => inWindow(rule, row, from) }],
      )
      const built = { full: full!, recent: recent! }
      // The full pair lives in LICENSED_BUCKET, and a whole table's recent entry names it too.
      const storedAt = (variant: BulkVariant, format: BulkFormat): StoredAt =>
        variant === 'recent' && rule.kind !== 'whole'
          ? { in: 'blob', key: bulkPath('recent', name, format) }
          : licensed
            ? { in: 'licensed', key: licensedKey(name, format) }
            : { in: 'blob', key: bulkPath('full', name, format) }

      const written = new Set<string>()
      for (const variant of BULK_VARIANTS) {
        for (const format of BULK_FORMATS) {
          const { body, sha256 } = built[variant][format]
          const stored = storedAt(variant, format)
          const contentType = BULK_CONTENT_TYPES[format]
          if (written.has(stored.key)) continue
          written.add(stored.key)
          if (stored.in === 'licensed') {
            await licensed!.put(stored.key, body, { contentType, sha256 })
          } else {
            await deps.store.put(stored.key, body, { contentType })
          }
        }
      }
      for (const variant of BULK_VARIANTS) {
        const cut = cuts[variant]
        for (const format of BULK_FORMATS) {
          const { body, rows, sha256 } = built[variant][format]
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
            stored: storedAt(variant, format),
          }
        }
      }
      delete failures[name]
      report.built.push(name)
    } catch (error) {
      failures[name] = { at: now().toISOString(), error: String(error) }
      report.failed.push({ file: name, error: String(error) })
    }
    await saveIndex()
  }
  if (licensed && report.built.length) {
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
