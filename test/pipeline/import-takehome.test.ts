import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../../server/db/schema'
import {
  IMPORT_JUDGE_SOURCE,
  existingIds,
  importStatements,
  inlineParams,
  isoFromDuckDb,
  parseCsv,
  parseTakehomeExport,
  planImport,
  renderStatement,
  type ImportPlan,
} from '../../server/pipeline/import/takehome'
import { pendingChanges } from '../../server/pipeline/judge/pending'
import { StoreValidationError, runStatements } from '../../server/pipeline/store'
import alertsCsv from './fixtures/takehome-export/alerts.csv?raw'
import changesCsv from './fixtures/takehome-export/changes.csv?raw'
import snapshotsCsv from './fixtures/takehome-export/snapshots.csv?raw'

// Rows carved from the real `make export` (2026-09-08), chosen for the edges:
// a fixture-baseline snapshot with a whole-second timestamp, a live one whose
// CSV fraction was trimmed, three EDGAR fetches with one payload, the single
// id whose fraction was `.000`, a headline with doubled quotes, and every
// change two alerts cite.

const db = drizzle(env.DB, { schema })
const csv = { snapshots: snapshotsCsv, changes: changesCsv, alerts: alertsCsv }
const NOW = () => new Date('2026-09-08T02:00:00.000Z')

beforeEach(async () => {
  await db.delete(schema.alerts)
  await db.delete(schema.changes)
  await db.delete(schema.snapshots)
  await db.delete(schema.judgeRuns)
})

const counts = (plan: ImportPlan) =>
  Object.fromEntries(
    Object.entries(plan).map(([t, p]) => [t, { insert: p.insert.length, skipped: p.skipped }]),
  )

async function stored() {
  return {
    snapshots: (await db.select().from(schema.snapshots)).length,
    changes: (await db.select().from(schema.changes)).length,
    alerts: (await db.select().from(schema.alerts)).length,
    judge_runs: await db.select().from(schema.judgeRuns),
  }
}

describe('parseCsv', () => {
  it('reads quoted commas, doubled quotes and embedded newlines', () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n1,\n')
    expect(rows).toEqual([
      { a: 'x, y', b: 'say "hi"\nthere' },
      { a: '1', b: '' },
    ])
  })

  it('rejects a ragged row rather than shifting columns', () => {
    expect(() => parseCsv('a,b\n1,2,3\n')).toThrow(/row 1 has 3 fields/)
  })
})

describe('isoFromDuckDb', () => {
  it('restores the three-digit fraction toISOString wrote', () => {
    expect(isoFromDuckDb('2026-08-25 22:16:44.99+00')).toBe('2026-08-25T22:16:44.990Z')
    expect(isoFromDuckDb('2026-08-25 22:16:44.993+00')).toBe('2026-08-25T22:16:44.993Z')
    expect(isoFromDuckDb('2026-08-25 11:10:40+00')).toBe('2026-08-25T11:10:40.000Z')
  })

  it('refuses anything that is not a UTC render', () => {
    expect(() => isoFromDuckDb('2026-08-25 11:10:40-04')).toThrow(/not a UTC/)
    expect(() => isoFromDuckDb('')).toThrow(/not a UTC/)
  })
})

describe('parseTakehomeExport', () => {
  const rows = parseTakehomeExport(csv, NOW)

  it('validates every row through the store contracts', () => {
    expect(rows.snapshots).toHaveLength(6)
    expect(rows.changes).toHaveLength(15)
    expect(rows.alerts).toHaveLength(2)
    const added = rows.changes.find((c) => c.change_type === 'added')!
    expect(added.before_hash).toBeNull()
    expect(added.before_json).toBeNull()
    expect(rows.changes.map((c) => c.detected_at)).toContain('2026-08-27T20:20:46.990Z')
    expect(rows.alerts[0]!.headline).toBe(
      'OpenAI opens dedicated "Partner Director, PwC" role in its Partnerships team',
    )
  })

  it('takes fetched_at from the snapshot id, which kept what the CSV trimmed', () => {
    const at = Object.fromEntries(rows.snapshots.map((s) => [s.id, s.fetched_at]))
    expect(at['xai-models-md:2026-08-25T11:10:41Z']).toBe('2026-08-25T11:10:41Z')
    expect(at['xai-models-md:2026-08-25T22:16:44.740Z']).toBe('2026-08-25T22:16:44.740Z')
    expect(at['edgar-fts:2026-09-07T13:47:17.000Z']).toBe('2026-09-07T13:47:17.000Z')
  })

  it("assigns raw_key the Worker's way: one object per run of identical payloads", () => {
    const edgar = rows.snapshots.filter((s) => s.source_id === 'edgar-submissions-spcx')
    expect(edgar).toHaveLength(3)
    expect(new Set(edgar.map((s) => s.raw_key))).toEqual(
      new Set(['raw/edgar-submissions-spcx/2026-08-25T11:10:55Z.json']),
    )
    const xai = rows.snapshots.filter((s) => s.source_id === 'xai-models-md')
    expect(xai.map((s) => s.raw_key)).toEqual([
      'raw/xai-models-md/2026-08-25T11:10:41Z.md',
      'raw/xai-models-md/2026-08-25T22:16:44.740Z.md',
    ])
    expect(rows.rawObjects).toHaveLength(4)
    expect(rows.rawObjects.find((o) => o.key.endsWith('11:10:55Z.json'))).toEqual({
      key: 'raw/edgar-submissions-spcx/2026-08-25T11:10:55Z.json',
      raw_path: 'fixtures/sec/edgar-submissions-spcx.json',
      content_hash: edgar[0]!.content_hash,
      content_type: 'application/json',
    })
    expect(rows.rawObjects.map((o) => o.content_type)).toContain('text/markdown')
  })

  it('writes one judge cursor at the newest imported detected_at', () => {
    expect(rows.judgeRun).toEqual({
      id: 'import:takehome:2026-09-02T00:35:24.934Z',
      started_at: '2026-09-08T02:00:00.000Z',
      judged_through: '2026-09-02T00:35:24.934Z',
      changes_seen: 15,
      accepted: 0,
      rejected: 0,
      rejection_reason: null,
      source: IMPORT_JUDGE_SOURCE,
    })
  })

  it('rejects a row the store would reject, naming it', () => {
    const bad = changesCsv.replace(',job,xai,', ',job,meta,')
    expect(bad).not.toBe(changesCsv)
    expect(() => parseTakehomeExport({ ...csv, changes: bad }, NOW)).toThrow(StoreValidationError)
    expect(() => parseTakehomeExport({ ...csv, changes: bad }, NOW)).toThrow(/provider/)
  })
})

describe('import into D1', () => {
  it('inserts once, then skips everything, and retires the history from the judge', async () => {
    const rows = parseTakehomeExport(csv, NOW)

    const first = planImport(rows, await existingIds(db))
    expect(counts(first)).toEqual({
      snapshots: { insert: 6, skipped: 0 },
      changes: { insert: 15, skipped: 0 },
      alerts: { insert: 2, skipped: 0 },
      judge_runs: { insert: 1, skipped: 0 },
    })
    await runStatements(db, importStatements(db, first))

    const after = await stored()
    expect(after.snapshots).toBe(6)
    expect(after.changes).toBe(15)
    expect(after.alerts).toBe(2)
    expect(after.judge_runs).toHaveLength(1)
    expect(after.judge_runs[0]!.source).toBe('import')

    // The cursor GET /api/judge/pending reads: nothing imported is pending.
    const pending = await pendingChanges(db)
    expect(pending.since).toBe('2026-09-02T00:35:24.934Z')
    expect(pending.total_pending).toBe(0)

    const second = planImport(rows, await existingIds(db))
    expect(counts(second)).toEqual({
      snapshots: { insert: 0, skipped: 6 },
      changes: { insert: 0, skipped: 15 },
      alerts: { insert: 0, skipped: 2 },
      judge_runs: { insert: 0, skipped: 1 },
    })
    expect(importStatements(db, second)).toHaveLength(0)
    expect(await stored()).toEqual(after)
  })

  it('does nothing on conflict even when the plan is stale', async () => {
    const rows = parseTakehomeExport(csv, NOW)
    const plan = planImport(rows, await existingIds(db))
    await runStatements(db, importStatements(db, plan))
    // Same plan again — a concurrent writer between plan and insert.
    await runStatements(db, importStatements(db, plan))
    expect((await stored()).changes).toBe(15)
  })

  it('renders the same statements to SQL wrangler can ingest, idempotently', async () => {
    const rows = parseTakehomeExport(csv, NOW)
    const plan = planImport(rows, await existingIds(db))
    const sql = importStatements(db, plan).map(renderStatement)
    expect(sql.length).toBeGreaterThan(0)
    for (const statement of sql) {
      expect(statement).toMatch(/^insert into "\w+" \(.+\) values \(.+\) on conflict do nothing$/s)
    }

    for (const round of [1, 2]) {
      for (const statement of sql) await env.DB.prepare(statement).run()
      const after = await stored()
      expect([
        round,
        after.snapshots,
        after.changes,
        after.alerts,
        after.judge_runs.length,
      ]).toEqual([round, 6, 15, 2, 1])
    }
    const [alert] = await db
      .select()
      .from(schema.alerts)
      .where(eq(schema.alerts.id, rows.alerts[0]!.id))
    expect(alert?.headline).toBe(rows.alerts[0]!.headline)
    expect(alert?.explanation).toBe(rows.alerts[0]!.explanation)
  })
})

describe('inlineParams', () => {
  it('quotes strings, doubles apostrophes, and passes numbers and NULL through', () => {
    expect(inlineParams('insert into t values (?, ?, ?, ?)', ["O'Brien", 42, null, true])).toBe(
      "insert into t values ('O''Brien', 42, NULL, 1)",
    )
  })

  it('refuses a placeholder/parameter mismatch or a non-scalar', () => {
    expect(() => inlineParams('values (?, ?)', ['a'])).toThrow(/2 placeholders but 1 params/)
    expect(() => inlineParams('values (?)', [{ a: 1 }])).toThrow(/cannot render/)
  })
})
