import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { zstdDecompressSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { HISTORY_LICENSE, PAID_LICENSE } from '~~/shared/utils/license'
import { LICENSED_BUCKET } from '../shared/utils/institutional'
import { contentHashOfText } from '../server/pipeline/contracts'
import { insertRows } from '../server/pipeline/store'
import { SCHEMA_VERSION } from '../server/utils/data-schema'
import {
  BULK_INDEX_PATH,
  LICENSED_MANIFEST_KEY,
  byteRange,
  bulkFileOf,
  bulkManifest,
  bulkPath,
  licensedKey,
  licensedStoreOf,
  notModified,
  readBulkIndex,
  runBulkBuild,
  type BulkManifest,
  type BulkStore,
} from '../server/utils/terminal-bulk'
import { EXPORT_TABLES } from '../server/utils/terminal-export'

// The bulk feed against a real D1: files land in the store, gzipped CSV and
// Parquet, with a SHA-256 that matches their bytes, the recent file is the
// license window, the full file labels every row, the full files (and only
// they) are copied to the licensed bucket, and a second run the same day does
// nothing.

const db = drizzle(env.DB, { schema })
const NOW = new Date('2026-11-04T03:41:00.000Z')
const TABLES = {
  snapshots: EXPORT_TABLES.snapshots!,
  entity_securities: EXPORT_TABLES.entity_securities!,
}

function memoryStore(): BulkStore & { data: Map<string, Uint8Array | string> } {
  const data = new Map<string, Uint8Array | string>()
  return {
    data,
    async put(path, body) {
      data.set(path, body)
    },
    async get(path) {
      const body = data.get(path)
      return body === undefined ? null : new Blob([body])
    },
  }
}

function snapshot(fetched_at: string) {
  return {
    id: `xai-models-md:${fetched_at}`,
    source_id: 'xai-models-md',
    content_hash: contentHashOfText(fetched_at),
    raw_key: `raw/xai-models-md/${fetched_at}.md`,
    http_status: 200,
    bytes: 1,
    source_url: 'https://docs.x.ai/developers/models.md',
    fetched_at,
  }
}

async function gunzip(body: Uint8Array | string): Promise<string> {
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

async function sha256(body: Uint8Array | string): Promise<string> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A Parquet file's rows and footer, read with hyparquet (zstd through node:zlib). */
async function readParquet(body: Uint8Array | string | undefined) {
  if (!(body instanceof Uint8Array)) throw new Error('no Parquet file there')
  const file = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  const rows = await parquetReadObjects({
    file,
    compressors: { ZSTD: (input) => new Uint8Array(zstdDecompressSync(input)) },
  })
  const metadata = parquetMetadata(file)
  const kv = Object.fromEntries(
    (metadata.key_value_metadata ?? []).map(({ key, value }) => [key, value]),
  )
  return { rows, metadata, kv }
}

beforeAll(async () => {
  await insertRows(db, 'snapshots', [
    snapshot('2026-01-02T00:00:00.000Z'), // before the window, after nothing: NC once old
    snapshot('2026-11-04T00:00:00.000Z'),
    snapshot('2026-11-04T01:00:00.000Z'),
  ])
})

describe('the bulk build', () => {
  it('writes each table twice in each format, with the hash of the bytes it wrote', async () => {
    const store = memoryStore()
    const report = await runBulkBuild({ db, store, now: () => NOW, tables: TABLES })
    expect(report.failed).toEqual([])
    expect(report.built.sort()).toEqual([
      'full/entity_securities',
      'full/snapshots',
      'recent/entity_securities',
      'recent/snapshots',
    ])

    const index = await readBulkIndex(store)
    expect(Object.keys(index.files)).toHaveLength(8)
    for (const file of Object.values(index.files)) {
      const body = store.data.get(bulkPath(file.variant, file.table, file.format))!
      expect(await sha256(body), file.table).toBe(file.sha256)
      expect(file.bytes).toBe((body as Uint8Array).byteLength)
      expect(file.schema_version).toBe(SCHEMA_VERSION)
      expect(file.generated_at).toBe(NOW.toISOString())
    }

    const recent = index.files['recent/snapshots.csv.gz']!
    expect(recent).toMatchObject({ rows: 2, license: 'CC-BY-4.0', from: '2026-08-06' })
    const recentCsv = (
      await gunzip(store.data.get(bulkPath('recent', 'snapshots', 'csv.gz'))!)
    ).split('\r\n')
    expect(recentCsv[0]).toBe(recent.columns.join(','))
    expect(recentCsv.filter(Boolean)).toHaveLength(3)

    const full = index.files['full/snapshots.csv.gz']!
    expect(full).toMatchObject({ rows: 3, license: null, from: null })
    expect(full.columns).toContain('license')
    const fullCsv = await gunzip(store.data.get(bulkPath('full', 'snapshots', 'csv.gz'))!)
    // The old row was first published before the split, so it stays CC BY.
    expect(fullCsv).toContain('CC-BY-4.0')
    expect(fullCsv).not.toContain('CC-BY-NC-4.0')

    // A lookup table is whole in both files.
    expect(index.files['recent/entity_securities.csv.gz']!.rows).toBe(
      index.files['full/entity_securities.csv.gz']!.rows,
    )
  })

  it('writes the same rows and columns as Parquet, typed, with the license in its metadata', async () => {
    const store = memoryStore()
    await runBulkBuild({ db, store, now: () => NOW, tables: TABLES })
    const index = await readBulkIndex(store)

    const csv = index.files['full/snapshots.csv.gz']!
    expect(index.files['full/snapshots.parquet']).toMatchObject({
      rows: 3,
      columns: csv.columns,
      license: null,
      license_older: PAID_LICENSE.id,
    })
    const { rows, metadata, kv } = await readParquet(
      store.data.get(bulkPath('full', 'snapshots', 'parquet')),
    )
    expect(rows).toHaveLength(3)
    expect(Object.keys(rows[0]!)).toEqual(csv.columns)
    expect(metadata.row_groups[0]!.columns[0]!.meta_data!.codec).toBe('ZSTD')
    const old = rows.find((r) => r.id === 'xai-models-md:2026-01-02T00:00:00.000Z')!
    expect(old).toMatchObject({
      http_status: 200n,
      bytes: 1n,
      license: 'CC-BY-4.0',
      source_url: 'https://docs.x.ai/developers/models.md',
    })
    expect((old.fetched_at as Date).toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(kv).toMatchObject({
      'frontier_terminal.table': 'snapshots',
      'frontier_terminal.history': 'full',
      'frontier_terminal.schema_version': SCHEMA_VERSION,
      'frontier_terminal.license': 'per row, in the license column',
      'frontier_terminal.license_older': PAID_LICENSE.id,
    })

    const recent = await readParquet(store.data.get(bulkPath('recent', 'snapshots', 'parquet')))
    expect(recent.rows).toHaveLength(2)
    expect(Object.keys(recent.rows[0]!)).not.toContain('license')
    expect(recent.kv['frontier_terminal.license']).toBe('CC-BY-4.0')
  })

  it('keeps CC BY-NC on an archived table’s older rows in the full Parquet file too', async () => {
    const store = memoryStore()
    const later = new Date('2027-06-01T03:41:00.000Z')
    const tables = { archived_prices: EXPORT_TABLES.archived_prices! }
    const report = await runBulkBuild({ db, store, now: () => later, tables })
    expect(report.failed).toEqual([])
    const { kv } = await readParquet(store.data.get(bulkPath('full', 'archived_prices', 'parquet')))
    expect(kv['frontier_terminal.license_older']).toBe(HISTORY_LICENSE.id)
    const index = await readBulkIndex(store)
    expect(index.files['full/archived_prices.parquet']!.license_older).toBe(HISTORY_LICENSE.id)
    const manifest = bulkManifest(index, 'full', 'https://example.com')
    expect(manifest.tables[0]!.license_older).toBe(HISTORY_LICENSE.id)
    expect(manifest.license.note).toContain('archived_prices')
  })

  it('labels a full file’s older rows with the paid license, not CC BY-NC', async () => {
    const store = memoryStore()
    const later = new Date('2027-06-01T03:41:00.000Z')
    await insertRows(db, 'snapshots', [snapshot('2026-12-01T00:00:00.000Z')])
    await runBulkBuild({ db, store, now: () => later, tables: TABLES })
    const fullCsv = await gunzip(store.data.get(bulkPath('full', 'snapshots', 'csv.gz'))!)
    expect(fullCsv).toContain(PAID_LICENSE.id)
    expect(fullCsv).not.toContain('CC-BY-NC-4.0')
    const { rows } = await readParquet(store.data.get(bulkPath('full', 'snapshots', 'parquet')))
    expect(rows.map((r) => r.license)).toContain(PAID_LICENSE.id)
    expect(rows.map((r) => r.license)).not.toContain('CC-BY-NC-4.0')
  })

  it('copies the full files, and only those, to the licensed bucket with a manifest', async () => {
    const store = memoryStore()
    const licensed = memoryStore()
    await runBulkBuild({
      db,
      store,
      licensed,
      appUrl: 'https://example.com',
      now: () => NOW,
      tables: TABLES,
    })
    expect([...licensed.data.keys()].sort()).toEqual(
      [
        licensedKey('entity_securities', 'csv.gz'),
        licensedKey('entity_securities', 'parquet'),
        licensedKey('snapshots', 'csv.gz'),
        licensedKey('snapshots', 'parquet'),
        LICENSED_MANIFEST_KEY,
      ].sort(),
    )
    expect(licensed.data.get(licensedKey('snapshots', 'parquet'))).toEqual(
      store.data.get(bulkPath('full', 'snapshots', 'parquet')),
    )
    const manifest = JSON.parse(licensed.data.get(LICENSED_MANIFEST_KEY) as string) as BulkManifest
    expect(manifest.history).toBe('full')
    const snapshots = manifest.tables.find((t) => t.table === 'snapshots')!
    expect(snapshots.s3_key).toBe('full/snapshots.csv.gz')
    expect(snapshots.parquet?.s3_key).toBe('full/snapshots.parquet')
    expect(snapshots.url).toBe('https://example.com/export/bulk/full/snapshots.csv.gz')

    // Built today before the bucket was bound, the full cuts are rebuilt once it is.
    const earlier = memoryStore()
    await runBulkBuild({ db, store: earlier, now: () => NOW, tables: TABLES })
    const copy = memoryStore()
    const report = await runBulkBuild({
      db,
      store: earlier,
      licensed: copy,
      now: () => NOW,
      tables: TABLES,
    })
    expect(report.built.sort()).toEqual(['full/entity_securities', 'full/snapshots'])
    expect(copy.data.has(LICENSED_MANIFEST_KEY)).toBe(true)
  })

  it('reads the licensed bucket off the Worker env, and nothing when it isn’t bound', async () => {
    expect(licensedStoreOf(undefined)).toBeNull()
    expect(licensedStoreOf({ BLOB: {} })).toBeNull()
    const bucket = (env as unknown as Record<string, R2Bucket>).BULK_LICENSED!
    const store = licensedStoreOf({ BULK_LICENSED: bucket })!
    const body = new TextEncoder().encode('x')
    const digest = await sha256(body)
    await store.put('full/x.csv.gz', body, { contentType: 'application/gzip', sha256: digest })
    const object = await bucket.get('full/x.csv.gz')
    expect(object?.customMetadata).toEqual({ sha256: digest })
    expect(object?.httpMetadata?.contentType).toBe('application/gzip')
    await object?.arrayBuffer()
    // R2 refuses a body whose hash isn't the one stated.
    await expect(store.put('full/y.csv.gz', body, { sha256: '0'.repeat(64) })).rejects.toThrow()
  })

  it('does nothing on a second run the same day, and resumes what a spent budget left', async () => {
    const store = memoryStore()
    let clock = NOW.getTime()
    // Each read of the clock moves it a second: a 1.5s budget builds two cuts.
    const now = () => new Date((clock += 1_000))
    const first = await runBulkBuild({ db, store, now, budgetMs: 1_500, tables: TABLES })
    expect(first.built.length).toBeGreaterThan(0)
    expect(first.deferred.length).toBeGreaterThan(0)
    const second = await runBulkBuild({ db, store, now: () => NOW, tables: TABLES })
    expect(second.built.sort()).toEqual(first.deferred.sort())
    const third = await runBulkBuild({ db, store, now: () => NOW, tables: TABLES })
    expect(third).toEqual({ built: [], failed: [], deferred: [] })
    expect(store.data.has(BULK_INDEX_PATH)).toBe(true)
  })

  it('drops an index entry from before formats were keyed', async () => {
    const store = memoryStore()
    await runBulkBuild({ db, store, now: () => NOW, tables: TABLES })
    const index = await readBulkIndex(store)
    const csv = index.files['recent/snapshots.csv.gz']!
    const old = { ...csv } as Partial<typeof csv>
    delete old.format
    await store.put(
      BULK_INDEX_PATH,
      JSON.stringify({ files: { ...index.files, 'recent/snapshots': old } }),
    )
    expect(Object.keys((await readBulkIndex(store)).files)).not.toContain('recent/snapshots')
  })
})

describe('the manifest', () => {
  it('lists the recent files to anyone and the full files to a key', async () => {
    const store = memoryStore()
    await runBulkBuild({ db, store, now: () => NOW, tables: TABLES })
    const index = await readBulkIndex(store)

    const anonymous = bulkManifest(index, 'recent', 'https://example.com')
    expect(anonymous.schema_version).toBe(SCHEMA_VERSION)
    expect(anonymous.history).toBe('recent')
    expect(anonymous.license.older).toBeNull()
    expect(anonymous.tables.map((t) => t.url)).toEqual([
      'https://example.com/export/bulk/recent/entity_securities.csv.gz',
      'https://example.com/export/bulk/recent/snapshots.csv.gz',
    ])
    expect(anonymous.tables.map((t) => t.parquet?.url)).toEqual([
      'https://example.com/export/bulk/recent/entity_securities.parquet',
      'https://example.com/export/bulk/recent/snapshots.parquet',
    ])
    expect(anonymous.generated_at).toBe(NOW.toISOString())
    // Nothing anonymous points at the licensed bucket.
    expect(anonymous.s3).toBeNull()
    expect(anonymous.tables.every((t) => t.s3_key === null && t.parquet?.s3_key === null)).toBe(
      true,
    )

    const keyed = bulkManifest(index, 'full', 'https://example.com')
    expect(keyed.license.older).toBe(PAID_LICENSE.id)
    const snapshots = keyed.tables.find((t) => t.table === 'snapshots')!
    expect(snapshots).toMatchObject({ license: null, license_column: 'license' })
    expect(snapshots.url).toBe('https://example.com/export/bulk/full/snapshots.csv.gz')
    expect(snapshots.parquet).toMatchObject({
      url: 'https://example.com/export/bulk/full/snapshots.parquet',
      format: 'parquet',
      rows: snapshots.rows,
      schema_version: SCHEMA_VERSION,
      s3_key: 'full/snapshots.parquet',
    })
    expect(keyed.s3?.bucket).toBe(LICENSED_BUCKET)
  })

  it('finds a file by its path, and nothing else', async () => {
    const store = memoryStore()
    await runBulkBuild({ db, store, now: () => NOW, tables: TABLES })
    const index = await readBulkIndex(store)
    expect(bulkFileOf(index, 'full', 'snapshots.csv.gz')?.table).toBe('snapshots')
    expect(bulkFileOf(index, 'recent', 'snapshots.parquet')?.format).toBe('parquet')
    expect(bulkFileOf(index, 'full', 'snapshots.csv')).toBeNull()
    expect(bulkFileOf(index, 'full', '.parquet')).toBeNull()
    expect(bulkFileOf(index, 'other', 'snapshots.csv.gz')).toBeNull()
    expect(bulkFileOf(index, 'recent', 'changes.csv.gz')).toBeNull()
  })

  it('serves one byte range, and the whole file for anything else', () => {
    expect(byteRange(undefined, 100)).toBeNull()
    expect(byteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(byteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=-8', 100)).toEqual({ start: 92, end: 99 })
    expect(byteRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    expect(byteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(byteRange('bytes=9-3', 100)).toBe('unsatisfiable')
    expect(byteRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(byteRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(byteRange('items=0-1', 100)).toBeNull()
  })

  it('answers a conditional request by ETag first, then by date', () => {
    const at = '2026-11-04T03:41:00.500Z'
    expect(notModified('"abc"', undefined, '"abc"', at)).toBe(true)
    expect(notModified('"x", "abc"', undefined, '"abc"', at)).toBe(true)
    expect(notModified('"x"', 'Wed, 04 Nov 2026 03:41:00 GMT', '"abc"', at)).toBe(false)
    expect(notModified(undefined, 'Wed, 04 Nov 2026 03:41:00 GMT', '"abc"', at)).toBe(true)
    expect(notModified(undefined, 'Wed, 04 Nov 2026 03:40:00 GMT', '"abc"', at)).toBe(false)
    expect(notModified(undefined, undefined, '"abc"', at)).toBe(false)
  })
})
