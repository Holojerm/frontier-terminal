import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  GRANT_ID_SHAPE,
  R2_BUCKET_ITEM_READ,
  expiresOn,
  generateGrantId,
  grantPolicies,
  r2Endpoint,
  s3SecretOf,
  staleGrants,
} from '../server/utils/bulk-grant'
import { EXPORT_TABLES } from '../server/utils/terminal-export'
import { licensedColumns } from '../server/utils/terminal-export-history'
import { type ExportTable } from '../server/utils/terminal-export-views'
import {
  PARQUET_CODEC,
  parquetBuilder,
  parquetSchema,
  parquetValue,
  timestampMicros,
} from '../server/utils/terminal-parquet'

// The Parquet half of the bulk feed, without D1: every exported column has a
// Parquet type, values convert or fail loudly, and a file split into row
// groups reads back whole. Plus the pure half of the S3 grants.

async function read(body: Uint8Array) {
  const file = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  const rows = await parquetReadObjects({
    file,
    compressors: { GZIP: (input) => new Uint8Array(gunzipSync(input)) },
  })
  return { rows, metadata: parquetMetadata(file) }
}

const TINY: ExportTable = {
  ...EXPORT_TABLES.snapshots!,
  name: 'snapshots',
}

describe('the Parquet schema', () => {
  it('types every column of every export, with and without the license column', () => {
    for (const table of Object.values(EXPORT_TABLES)) {
      const schema = parquetSchema(table)
      expect(schema[0]).toEqual({ name: 'root', num_children: table.columns.length })
      expect(schema.slice(1).map((s) => s.name)).toEqual([...table.columns])
      expect(schema.slice(1).every((s) => s.repetition_type === 'OPTIONAL')).toBe(true)
      const licensed = { ...table, columns: licensedColumns(table.columns) }
      expect(parquetSchema(licensed).find((s) => s.name === 'license')?.converted_type).toBe('UTF8')
    }
  })

  it('refuses a column the data dictionary has no type for', () => {
    expect(() => parquetSchema({ ...TINY, columns: ['id', 'mystery'] })).toThrow(/mystery/)
  })
})

describe('a cell as Parquet', () => {
  it('keeps the digits past the millisecond, and reads an offset as its instant', () => {
    expect(timestampMicros('2026-11-04T00:00:00Z')).toBe(1_793_750_400_000_000n)
    expect(timestampMicros('2026-11-04T00:00:00.123456Z')).toBe(1_793_750_400_123_456n)
    expect(timestampMicros('2026-11-04T00:00:00.1234Z')).toBe(1_793_750_400_123_400n)
    expect(timestampMicros('2026-11-04T02:00:00+02:00')).toBe(1_793_750_400_000_000n)
    expect(timestampMicros('2026-11-04')).toBeNull()
    expect(timestampMicros('soon')).toBeNull()
  })

  it('converts each dictionary type, and throws on a value that doesn’t fit', () => {
    expect(parquetValue('integer', 'n', 5)).toBe(5n)
    expect(parquetValue('integer', 'n', '7')).toBe(7n)
    expect(() => parquetValue('integer', 'n', 1.5)).toThrow(/n: 1.5 is not a integer/)
    expect(() => parquetValue('integer', 'n', '')).toThrow()
    expect(parquetValue('number', 'x', '0.15')).toBe(0.15)
    expect(() => parquetValue('number', 'x', 'n/a')).toThrow()
    expect(parquetValue('boolean', 'b', 1)).toBe(true)
    expect(parquetValue('boolean', 'b', 0)).toBe(false)
    expect(() => parquetValue('boolean', 'b', 2)).toThrow()
    expect(parquetValue('date', 'd', '1970-01-03')).toBe(2)
    expect(() => parquetValue('date', 'd', '2026-11-04T00:00:00Z')).toThrow()
    expect(parquetValue('json', 'j', '{"a":[1]}')).toEqual({ a: [1] })
    expect(parquetValue('json', 'j', 'not json')).toBe('not json')
    expect(parquetValue('json', 'j', ['x'])).toEqual(['x'])
    expect(parquetValue('text', 't', 3)).toBe('3')
    expect(parquetValue('text', 't', ['a', 'b'])).toBe('["a","b"]')
    // The CSV defuses this with an apostrophe. Parquet keeps it verbatim.
    expect(parquetValue('text', 't', '=HYPERLINK("x")')).toBe('=HYPERLINK("x")')
    expect(parquetValue('timestamp', 'ts', null)).toBeNull()
    expect(parquetValue('integer', 'n', undefined)).toBeNull()
  })
})

describe('a Parquet file', () => {
  const row = (i: number) => ({
    id: `s:${i}`,
    source_id: 'xai-models-md',
    content_hash: 'h',
    raw_key: i % 2 ? null : `raw/${i}`,
    http_status: 200,
    bytes: i,
    source_url: 'https://docs.x.ai/developers/models.md',
    fetched_at: `2026-11-0${i + 1}T00:00:00.000Z`,
  })

  it('reads back whole across row groups, nulls included', async () => {
    const builder = parquetBuilder(TINY, { table: 'snapshots' }, { rows: 2, bytes: 1e9 })
    builder.add([row(0), row(1), row(2)])
    builder.add([row(3), row(4)])
    const { body, rows } = builder.finish()
    expect(rows).toBe(5)
    const back = await read(body)
    expect(back.metadata.row_groups).toHaveLength(3)
    expect(back.metadata.row_groups[0]!.columns[0]!.meta_data!.codec).toBe(PARQUET_CODEC)
    expect(back.rows.map((r) => r.id)).toEqual(['s:0', 's:1', 's:2', 's:3', 's:4'])
    expect(back.rows[1]).toMatchObject({ raw_key: null, bytes: 1n, http_status: 200n })
    expect((back.rows[4]!.fetched_at as Date).toISOString()).toBe('2026-11-05T00:00:00.000Z')
    expect(back.metadata.key_value_metadata).toContainEqual({
      key: 'frontier_terminal.table',
      value: 'snapshots',
    })
  })

  it('closes a row group at its text budget, however few rows that is', async () => {
    const wide = (i: number) => ({ ...row(i), raw_key: 'x'.repeat(600) })
    const builder = parquetBuilder(TINY, {}, { rows: 1_000, bytes: 1_000 })
    builder.add([wide(0), wide(1), wide(2), wide(3)])
    const back = await read(builder.finish().body)
    expect(back.metadata.row_groups.map((g) => Number(g.num_rows))).toEqual([2, 2])
    expect(back.rows).toHaveLength(4)
  })

  // 2026-11-05: zstd from workerd's node:zlib threw "Unexpected end of file" on
  // any page that compressed to more than ~40 KB, which every build of
  // snapshots (a column of SHA-256 hashes) hit. A page of hashes, in workerd.
  it('writes a page that compresses to well over 64 KB', async () => {
    const hex = () =>
      Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('')
    const rows = Array.from({ length: 4_000 }, (_, i) => ({ ...row(i % 5), content_hash: hex() }))
    const builder = parquetBuilder(TINY, {})
    builder.add(rows)
    const { body } = builder.finish()
    expect(body.byteLength).toBeGreaterThan(128 * 1024)
    const back = await read(body)
    expect(back.rows).toHaveLength(4_000)
    expect(back.rows[3_999]!.content_hash).toBe(rows[3_999]!.content_hash)
  })

  it('is a valid file with no rows', async () => {
    const { body, rows } = parquetBuilder(TINY, {}).finish()
    expect(rows).toBe(0)
    const back = await read(body)
    expect(back.rows).toEqual([])
    expect(back.metadata.schema.map((s) => s.name)).toEqual(['root', ...TINY.columns])
  })

  it('fails the file on a value its column can’t hold', () => {
    const builder = parquetBuilder(TINY, {})
    expect(() => builder.add([{ ...row(0), bytes: 'lots' }])).toThrow(/bytes/)
  })
})

describe('an S3 grant', () => {
  const account = '0123456789abcdef0123456789abcdef'

  it('asks for object read on the one bucket and nothing else', () => {
    expect(grantPolicies(account, 'frontier-terminal-bulk-licensed')).toEqual([
      {
        effect: 'allow',
        resources: {
          [`com.cloudflare.edge.r2.bucket.${account}_default_frontier-terminal-bulk-licensed`]: '*',
        },
        permission_groups: [{ id: R2_BUCKET_ITEM_READ.id }],
      },
    ])
    expect(() => grantPolicies('not-an-account', 'b')).toThrow()
    expect(r2Endpoint(account)).toBe(`https://${account}.r2.cloudflarestorage.com`)
  })

  it('derives the S3 secret as R2 does, and expires with the key', async () => {
    // SHA-256("abc"), the FIPS 180-2 test vector.
    expect(await s3SecretOf('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(expiresOn('2027-11-04T23:52:10.123Z')).toBe('2027-11-04T23:52:10Z')
    expect(GRANT_ID_SHAPE.test(generateGrantId())).toBe(true)
  })

  it('sweeps the live grants of revoked or expired keys, and only those', () => {
    const now = new Date('2026-11-05T00:00:00Z')
    const grant = (id: string, over: Partial<Parameters<typeof staleGrants>[0][number]>) => ({
      id,
      token_id: `t_${id}`,
      revoked_at: null,
      key_revoked: false,
      key_expires_at: '2027-01-01T00:00:00Z',
      ...over,
    })
    const stale = staleGrants(
      [
        grant('live', {}),
        grant('revoked-key', { key_revoked: true }),
        grant('expired-key', { key_expires_at: '2026-11-01T00:00:00Z' }),
        grant('already', { key_revoked: true, revoked_at: '2026-11-02T00:00:00Z' }),
      ],
      now,
    )
    expect(stale.map((s) => [s.grant.id, s.reason])).toEqual([
      ['revoked-key', 'key-revoked'],
      ['expired-key', 'key-expired'],
    ])
  })
})
