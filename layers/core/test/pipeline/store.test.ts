import { env } from 'cloudflare:test'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { ChangeRow, contentHash } from '../../server/pipeline/contracts'
import { changeId, repeatChangeId } from '../../server/pipeline/diff'
import {
  D1_MAX_BOUND_PARAMS,
  StoreValidationError,
  applyDiff,
  chunk,
  insertRows,
  latestGoodSnapshots,
  repeatedChangeIds,
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
  await db.delete(schema.entities)
  await db.delete(schema.changes)
  await db.delete(schema.snapshots)
  await db.delete(schema.sourceStats)
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

describe('applyDiff', () => {
  const entity = (n: number) => ({
    entity_key: `job:xai:${n}`,
    entity_type: 'job' as const,
    provider: 'xai' as const,
    snapshot_id: 'snap-1',
    content_hash: contentHash({ n }),
    payload: JSON.stringify({ n }),
    source_id: 'xai-greenhouse',
    first_seen_at: PROV.fetched_at,
    ...PROV,
  })
  const writes = (n: number) => ({
    upserts: [entity(n)],
    removed: [],
    changes: [change(n)],
    alerts: [],
  })

  it('writes the entity and its change row together', async () => {
    await applyDiff(db, 'xai-greenhouse', writes(1))
    expect(await db.select().from(schema.entities)).toHaveLength(1)
    expect(await db.select().from(schema.changes)).toHaveLength(1)
  })

  // The 2026-09-22 google-pricing-html failure: entities landed, the changes
  // INSERT did not, and the next tick diffed the re-added model to nothing.
  it('leaves the entity set and change log untouched when a later insert fails', async () => {
    // Enough entities to span several statements, then a change INSERT that
    // fails after them all, as the changes table did that day.
    await db.run(
      sql.raw(`CREATE TRIGGER fail_change BEFORE INSERT ON changes
        BEGIN SELECT RAISE(ABORT, 'change insert failed'); END`),
    )
    try {
      const many = Array.from({ length: 40 }, (_, i) => entity(100 + i))
      await expect(
        applyDiff(db, 'xai-greenhouse', { ...writes(2), upserts: many }),
      ).rejects.toThrow()
    } finally {
      await db.run(sql.raw('DROP TRIGGER fail_change'))
    }
    expect(await db.select().from(schema.entities)).toHaveLength(0)
    expect(await db.select().from(schema.changes)).toHaveLength(0)
  })

  it('upserts each row from its own values, across statements, and never moves first_seen_at', async () => {
    const first = Array.from({ length: 25 }, (_, i) => entity(200 + i))
    await applyDiff(db, 'xai-greenhouse', { upserts: first, removed: [], changes: [], alerts: [] })
    const LATER = '2026-09-08T10:00:00.000Z'
    const rewritten = first.map((e, i) => ({
      ...e,
      provider: 'other' as const,
      content_hash: contentHash({ n: i, v: 2 }),
      payload: JSON.stringify({ n: i, v: 2 }),
      snapshot_id: 'snap-2',
      source_url: 'https://job-boards.example/xai',
      fetched_at: LATER,
      first_seen_at: LATER,
    }))
    const fresh = { ...entity(300), fetched_at: LATER, first_seen_at: LATER }
    await applyDiff(db, 'xai-greenhouse', {
      upserts: [...rewritten, fresh],
      removed: [],
      changes: [],
      alerts: [],
    })

    const stored = new Map((await db.select().from(schema.entities)).map((r) => [r.entity_key, r]))
    expect(stored.size).toBe(26)
    for (const row of rewritten) {
      expect(stored.get(row.entity_key)).toEqual({ ...row, first_seen_at: PROV.fetched_at })
    }
    expect(stored.get(fresh.entity_key)).toEqual(fresh)
  })

  it('writes the snapshot with the entities that cite it', async () => {
    const snapshot = {
      id: 'snap-1',
      source_id: 'xai-greenhouse',
      content_hash: contentHash({ snap: 1 }),
      raw_key: 'raw/xai-greenhouse/snap-1.json',
      http_status: 200,
      bytes: 10,
      ...PROV,
    }
    await applyDiff(db, 'xai-greenhouse', { ...writes(5), snapshot })
    expect((await db.select().from(schema.snapshots)).map((s) => s.id)).toEqual(['snap-1'])
    expect(await db.select().from(schema.entities)).toHaveLength(1)
  })

  // edgar-fts and edgar-fts-openai both returned one filing; the second
  // source's identical change id hit the primary key and every tick rolled
  // back from 2026-10-09 on.
  it('applies the diff when another source already logged the same change', async () => {
    await insertRows(db, 'changes', [change(3)])
    await applyDiff(db, 'xai-greenhouse', writes(3))
    expect(await db.select().from(schema.entities)).toHaveLength(1)
    expect(await db.select().from(schema.changes)).toHaveLength(1)
  })

  // edgar-fts-openai, 2026-11-02: a concurrent source stored the alert between
  // this source's unstoredAlerts read and its write.
  it('applies the diff when another source already stored the same alert', async () => {
    const alert = {
      id: 'alert:filing:0000000000-26-000001',
      severity: 'critical',
      headline: 'S-1 filed',
      explanation: 'A registration statement was filed.',
      change_ids: JSON.stringify([change(4).id]),
      rule: 's1-floor',
      created_at: PROV.fetched_at,
      ...PROV,
    }
    await insertRows(db, 'alerts', [alert])
    await applyDiff(db, 'xai-greenhouse', { ...writes(4), alerts: [alert] })
    expect(await db.select().from(schema.entities)).toHaveLength(1)
    expect(await db.select().from(schema.alerts)).toHaveLength(1)
  })
})

describe('source_stats', () => {
  const snapshot = (fetched_at: string) => ({
    id: `xai-greenhouse:${fetched_at}`,
    source_id: 'xai-greenhouse',
    content_hash: contentHash({ fetched_at }),
    raw_key: `raw/xai-greenhouse/${fetched_at}.json`,
    http_status: 200,
    bytes: 10,
    source_url: PROV.source_url,
    fetched_at,
  })
  const run = (started_at: string) => ({
    id: `survey:xai-greenhouse:${started_at}`,
    scope: 'survey',
    source_id: 'xai-greenhouse',
    started_at,
    status: 'ok',
    detail: null,
    snapshot_id: null,
    added: 0,
    removed: 0,
    modified: 0,
    source_url: PROV.source_url,
  })
  const stats = async () => (await db.select().from(schema.sourceStats))[0]

  beforeEach(async () => {
    await db.delete(schema.sourceRuns)
  })

  it('counts every snapshot and keeps the first and newest, whatever order they arrive in', async () => {
    await insertRows(db, 'snapshots', [snapshot('2026-09-07T12:00:00.000Z')])
    await insertRows(db, 'snapshots', [
      snapshot('2026-09-07T10:00:00.000Z'),
      snapshot('2026-09-07T11:00:00.000Z'),
    ])
    expect(await stats()).toMatchObject({
      snapshot_count: 3,
      first_fetched_at: '2026-09-07T10:00:00.000Z',
      last_fetched_at: '2026-09-07T12:00:00.000Z',
      run_count: 0,
    })
  })

  it('counts runs into the same row', async () => {
    await insertRows(db, 'snapshots', [snapshot('2026-09-07T10:00:00.000Z')])
    await insertRows(db, 'source_runs', [run('2026-09-07T10:00:00.000Z')])
    await insertRows(db, 'source_runs', [run('2026-09-07T16:00:00.000Z')])
    expect(await stats()).toMatchObject({
      snapshot_count: 1,
      run_count: 2,
      last_run_at: '2026-09-07T16:00:00.000Z',
    })
  })

  it('does not count a snapshot whose insert failed', async () => {
    await insertRows(db, 'snapshots', [snapshot('2026-09-07T10:00:00.000Z')])
    await expect(
      insertRows(db, 'snapshots', [snapshot('2026-09-07T10:00:00.000Z')]),
    ).rejects.toThrow()
    expect((await stats())!.snapshot_count).toBe(1)
  })
})

describe('latestGoodSnapshots', () => {
  beforeEach(async () => {
    await db.delete(schema.sourceRuns)
  })

  it("reads each source's newest good run's snapshot, for more ids than one statement may bind", async () => {
    const at = (h: number) => `2026-09-07T${String(h).padStart(2, '0')}:00:00.000Z`
    const snap = (id: string, h: number) => ({
      id: `${id}:${at(h)}`,
      source_id: id,
      content_hash: contentHash({ id, h }),
      raw_key: `raw/${id}/${h}.json`,
      http_status: 200,
      bytes: 10,
      source_url: PROV.source_url,
      fetched_at: at(h),
    })
    const run = (id: string, h: number, status: string, parse_basis: string | null = null) => ({
      id: `survey:${id}:${at(h)}`,
      scope: 'survey',
      source_id: id,
      started_at: at(h),
      status,
      detail: null,
      snapshot_id: `${id}:${at(h)}`,
      added: 0,
      removed: 0,
      modified: 0,
      source_url: PROV.source_url,
      parse_basis,
    })
    await insertRows(db, 'snapshots', [snap('a', 10), snap('a', 11), snap('a', 12), snap('b', 10)])
    await insertRows(db, 'source_runs', [
      run('a', 10, 'ok'),
      run('a', 11, 'unchanged', '{"input":"i","context":"c"}'),
      run('a', 12, 'failed'),
      run('b', 10, 'failed'),
    ])

    const ids = ['a', 'b', ...Array.from({ length: 150 }, (_, n) => `none-${n}`)]
    const got = await latestGoodSnapshots(db, ids)
    expect([...got.keys()]).toEqual(['a'])
    expect(got.get('a')).toEqual({
      id: `a:${at(11)}`,
      content_hash: contentHash({ id: 'a', h: 11 }),
      raw_key: 'raw/a/11.json',
      source_url: PROV.source_url,
      parse_basis: '{"input":"i","context":"c"}',
    })
  })
})

describe('repeatedChangeIds', () => {
  const KEY = 'model:xai:grok-4.6:standard'
  const [h15, h10] = [contentHash({ p: 15 }), contentHash({ p: 10 })]
  const transition = (
    before_hash: string,
    after_hash: string,
    detected_at: string,
    source_url = PROV.source_url,
  ) =>
    ChangeRow.parse({
      id: changeId(KEY, before_hash, after_hash),
      entity_key: KEY,
      entity_type: 'model',
      provider: 'xai',
      change_type: 'modified',
      before_hash,
      after_hash,
      before_json: '{}',
      after_json: '{}',
      detected_at,
      source_url,
      fetched_at: detected_at,
    })

  it('re-keys a transition the entity made before and has since left', async () => {
    const down = transition(h15, h10, '2026-09-07T10:00:00.000Z')
    const up = transition(h10, h15, '2026-09-07T16:00:00.000Z')
    await insertRows(db, 'changes', [down, up])

    const again = transition(h15, h10, '2026-09-07T22:00:00.000Z')
    expect(again.id).toBe(down.id)
    expect(await repeatedChangeIds(db, [again])).toEqual(new Set([down.id]))
    const rekeyed = repeatChangeId(again)
    expect(rekeyed.id).not.toBe(down.id)
    await applyDiff(db, 'xai-models-md', {
      upserts: [],
      removed: [],
      changes: [rekeyed],
      alerts: [],
    })
    expect(await db.select().from(schema.changes)).toHaveLength(3)

    // An overlapping tick re-diffing the same two snapshots: the newest
    // change is that same transition, so it is one row, not two.
    const overlap = transition(h15, h10, '2026-09-07T22:00:01.000Z')
    expect(await repeatedChangeIds(db, [overlap])).toEqual(new Set())
  })

  it('keeps one row when another source logged the same transition first', async () => {
    const fts = transition(h15, h10, '2026-09-07T10:00:00.000Z', 'https://efts.sec.gov/x')
    await insertRows(db, 'changes', [
      fts,
      transition(h10, h15, '2026-09-07T16:00:00.000Z', 'https://efts.sec.gov/x'),
    ])
    const subs = transition(h15, h10, '2026-09-07T22:00:00.000Z')
    expect(await repeatedChangeIds(db, [subs])).toEqual(new Set())
  })

  it('a first sighting is not a repeat', async () => {
    expect(await repeatedChangeIds(db, [transition(h15, h10, PROV.fetched_at)])).toEqual(new Set())
  })
})
