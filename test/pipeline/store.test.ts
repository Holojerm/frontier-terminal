import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../../server/db/schema'
import { ChangeRow, contentHash } from '../../server/pipeline/contracts'
import {
  D1_MAX_BOUND_PARAMS,
  StoreValidationError,
  chunk,
  insertRows,
  rowsPerStatement,
} from '../../server/pipeline/store'

// The write chokepoint against a real D1. The property that matters is the
// provenance gate: a row without source_url + fetched_at never reaches the
// table, and a bad row in a batch keeps the whole batch out.

const db = drizzle(env.DB, { schema })

const PROV = {
  source_url: 'https://boards-api.greenhouse.io/v1/boards/xai/jobs',
  fetched_at: '2026-09-07T10:00:00.000Z',
}

function change(n: number): ChangeRow {
  const after_hash = contentHash({ n })
  return ChangeRow.parse({
    id: contentHash({ entity_key: `job:xai:${n}`, before_hash: null, after_hash }),
    entity_key: `job:xai:${n}`,
    entity_type: 'job',
    provider: 'xai',
    change_type: 'added',
    before_hash: null,
    after_hash,
    before_json: null,
    after_json: JSON.stringify({ n }),
    detected_at: PROV.fetched_at,
    ...PROV,
  })
}

beforeEach(async () => {
  await db.delete(schema.changes)
  await db.delete(schema.snapshots)
})

describe('insertRows', () => {
  it('rejects a row without provenance and writes nothing — not even the good rows beside it', async () => {
    const { source_url: _url, ...noUrl } = change(1)
    await expect(insertRows(db, 'changes', [change(0), noUrl])).rejects.toThrow(
      StoreValidationError,
    )
    await expect(insertRows(db, 'changes', [{ ...change(2), fetched_at: null }])).rejects.toThrow(
      /fetched_at/,
    )
    expect(await db.select().from(schema.changes)).toHaveLength(0)
  })

  it('names the table, the row and the field in the error', async () => {
    const { fetched_at: _at, ...row } = change(3)
    const err = await insertRows(db, 'snapshots', [row]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoreValidationError)
    expect(String(err)).toMatch(/^StoreValidationError: snapshots\[0\] rejected: /)
  })

  it('writes more rows than one statement may bind, across a batch', async () => {
    const rows = Array.from({ length: 250 }, (_, n) => change(n))
    expect(await insertRows(db, 'changes', rows)).toBe(250)
    const stored = await db.select().from(schema.changes)
    expect(stored).toHaveLength(250)
    expect(new Set(stored.map((r) => r.id)).size).toBe(250)
  })

  it('returns 0 and touches nothing for an empty list', async () => {
    expect(await insertRows(db, 'changes', [])).toBe(0)
  })
})

describe('D1 bound-parameter chunking', () => {
  it('keeps every statement within the 100-parameter cap for each table width', () => {
    for (const columns of [8, 9, 10, 11, 12]) {
      const perStatement = rowsPerStatement(columns)
      expect(perStatement * columns).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS)
      expect((perStatement + 1) * columns).toBeGreaterThan(D1_MAX_BOUND_PARAMS)
    }
    // Miniflare would happily bind more, so the arithmetic is the test.
    expect(rowsPerStatement(12)).toBe(8)
  })

  it('chunks without dropping or duplicating', () => {
    const groups = chunk([1, 2, 3, 4, 5, 6, 7], 3)
    expect(groups).toEqual([[1, 2, 3], [4, 5, 6], [7]])
  })
})
