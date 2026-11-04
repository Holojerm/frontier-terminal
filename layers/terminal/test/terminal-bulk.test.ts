import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { PAID_LICENSE } from '~~/shared/utils/license'
import { contentHashOfText } from '../server/pipeline/contracts'
import { insertRows } from '../server/pipeline/store'
import { SCHEMA_VERSION } from '../server/utils/data-schema'
import {
  BULK_INDEX_PATH,
  bulkFileOf,
  bulkManifest,
  bulkPath,
  notModified,
  readBulkIndex,
  runBulkBuild,
  type BulkStore,
} from '../server/utils/terminal-bulk'
import { EXPORT_TABLES } from '../server/utils/terminal-export'

// The bulk feed against a real D1: files land in the store gzipped with a
// SHA-256 that matches their bytes, the recent file is the license window,
// the full file labels every row, and a second run the same day does nothing.

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

beforeAll(async () => {
  await insertRows(db, 'snapshots', [
    snapshot('2026-01-02T00:00:00.000Z'), // before the window, after nothing: NC once old
    snapshot('2026-11-04T00:00:00.000Z'),
    snapshot('2026-11-04T01:00:00.000Z'),
  ])
})

describe('the bulk build', () => {
  it('writes each table twice, gzipped, with the hash of the bytes it wrote', async () => {
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
    for (const file of Object.values(index.files)) {
      const body = store.data.get(bulkPath(file.variant, file.table))!
      expect(await sha256(body), file.table).toBe(file.sha256)
      expect(file.bytes).toBe((body as Uint8Array).byteLength)
      expect(file.schema_version).toBe(SCHEMA_VERSION)
      expect(file.generated_at).toBe(NOW.toISOString())
    }

    const recent = index.files['recent/snapshots']!
    expect(recent).toMatchObject({ rows: 2, license: 'CC-BY-4.0', from: '2026-08-06' })
    const recentCsv = (await gunzip(store.data.get(bulkPath('recent', 'snapshots'))!)).split('\r\n')
    expect(recentCsv[0]).toBe(recent.columns.join(','))
    expect(recentCsv.filter(Boolean)).toHaveLength(3)

    const full = index.files['full/snapshots']!
    expect(full).toMatchObject({ rows: 3, license: null, from: null })
    expect(full.columns).toContain('license')
    const fullCsv = await gunzip(store.data.get(bulkPath('full', 'snapshots'))!)
    // The old row was first published before the split, so it stays CC BY.
    expect(fullCsv).toContain('CC-BY-4.0')
    expect(fullCsv).not.toContain('CC-BY-NC-4.0')

    // A lookup table is whole in both files.
    expect(index.files['recent/entity_securities']!.rows).toBe(
      index.files['full/entity_securities']!.rows,
    )
  })

  it('labels a full file’s older rows with the paid license, not CC BY-NC', async () => {
    const store = memoryStore()
    const later = new Date('2027-06-01T03:41:00.000Z')
    await insertRows(db, 'snapshots', [snapshot('2026-12-01T00:00:00.000Z')])
    await runBulkBuild({ db, store, now: () => later, tables: TABLES })
    const fullCsv = await gunzip(store.data.get(bulkPath('full', 'snapshots'))!)
    expect(fullCsv).toContain(PAID_LICENSE.id)
    expect(fullCsv).not.toContain('CC-BY-NC-4.0')
  })

  it('does nothing on a second run the same day, and resumes what a spent budget left', async () => {
    const store = memoryStore()
    let clock = NOW.getTime()
    // Each read of the clock moves it a second: a 1.5s budget builds two files.
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
    expect(anonymous.generated_at).toBe(NOW.toISOString())

    const keyed = bulkManifest(index, 'full', 'https://example.com')
    expect(keyed.license.older).toBe(PAID_LICENSE.id)
    const snapshots = keyed.tables.find((t) => t.table === 'snapshots')!
    expect(snapshots).toMatchObject({ license: null, license_column: 'license' })
    expect(snapshots.url).toBe('https://example.com/export/bulk/full/snapshots.csv.gz')
  })

  it('finds a file by its path, and nothing else', async () => {
    const store = memoryStore()
    await runBulkBuild({ db, store, now: () => NOW, tables: TABLES })
    const index = await readBulkIndex(store)
    expect(bulkFileOf(index, 'full', 'snapshots.csv.gz')?.table).toBe('snapshots')
    expect(bulkFileOf(index, 'full', 'snapshots.csv')).toBeNull()
    expect(bulkFileOf(index, 'other', 'snapshots.csv.gz')).toBeNull()
    expect(bulkFileOf(index, 'recent', 'changes.csv.gz')).toBeNull()
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
