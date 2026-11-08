import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { ChangeRow, contentHash } from '../../server/pipeline/contracts'
import { boardMoves, hiringBoards, scoreBoard } from '../../server/pipeline/hiring-floor'
import {
  HIRING_ROLLUP_RULE,
  hiringRollupAlerts,
  lastCompleteWeek,
  writeHiringRollups,
} from '../../server/pipeline/hiring-rollup'
import { submitJudgeRun } from '../../server/pipeline/judge/submit'
import { enqueueCriticalAlerts } from '../../server/pipeline/social'
import { insertRows } from '../../server/pipeline/store'
import { parseDepartmentClusters } from '../../server/utils/terminal-clusters'
import { NO_DEPARTMENT } from '../../server/utils/terminal-history'
import { fixtureText } from './fixtures'

// The hiring materiality floor: scored relative to the board and department,
// enforced at the judge's submit gate (only ever lowering a severity), and
// reused by the weekly roll-up, which is never critical and so never posted.

const db = drizzle(env.DB, { schema })
const clusters = parseDepartmentClusters(fixtureText('sources.yaml'))
const URL_XAI = 'https://boards-api.greenhouse.io/v1/boards/xai/jobs'

let seq = 0

function job(
  provider: string,
  change_type: 'added' | 'removed' | 'modified',
  department: string | null,
  detected_at = '2026-11-03T18:00:00.000Z',
  to?: string,
): ChangeRow {
  const n = ++seq
  const row = { job_id: String(n), title: `Role ${n}`, department, provider }
  const after = change_type === 'modified' ? { ...row, department: to } : row
  return ChangeRow.parse({
    id: contentHash({ n, provider, change_type }),
    entity_key: `job:${provider}:${n}`,
    entity_type: 'job',
    provider,
    change_type,
    before_hash: change_type === 'added' ? null : contentHash(row),
    after_hash: change_type === 'removed' ? null : contentHash(after),
    before_json: change_type === 'added' ? null : JSON.stringify(row),
    after_json: change_type === 'removed' ? null : JSON.stringify(after),
    detected_at,
    source_url: URL_XAI,
    fetched_at: detected_at,
  })
}

const many = (n: number, make: () => ChangeRow) => Array.from({ length: n }, make)

/** Open roles per department, as scoreBoard takes them. */
const board = (sizes: Record<string, number>) => new Map(Object.entries(sizes))

describe('scoreBoard', () => {
  it('leaves GTM churn on a large board below the floor', () => {
    const moves = [
      job('anthropic', 'added', 'Sales'),
      job('anthropic', 'added', 'Marketing & Brand'),
    ]
    const out = scoreBoard(
      'anthropic',
      moves,
      board({ Sales: 90, 'Marketing & Brand': 16, Other: 460 }),
      clusters,
    )
    expect(out).toMatchObject({ added: 2, removed: 0, net: 2, before: 564, now: 566 })
    expect(out.material).toEqual([])
  })

  it('clears it for a department emptied relative to its size: xAI Human Data, 12 of 14', () => {
    const moves = [
      ...many(12, () => job('xai', 'removed', 'Human Data')),
      job('xai', 'added', 'Model'),
    ]
    const out = scoreBoard(
      'xai',
      moves,
      board({ 'Human Data': 2, Model: 8, 'Data Center': 300 }),
      clusters,
    )
    expect(out.net).toBe(-11)
    expect(out.departments[0]).toMatchObject({
      department: 'Human Data',
      net: -12,
      before: 14,
      now: 2,
    })
    expect(out.material).toEqual([
      { kind: 'board', net: -11, before: 321 },
      { kind: 'department', department: 'Human Data', net: -12, before: 14 },
    ])
  })

  it('needs at least five roles AND a fifth of the department', () => {
    const score = (n: number, after: number) =>
      scoreBoard(
        'openai',
        many(n, () => job('openai', 'added', 'Marketing')),
        board({ Marketing: after, Other: 1000 }),
        clusters,
      ).material
    expect(score(5, 25)).toEqual([
      { kind: 'department', department: 'Marketing', net: 5, before: 20 },
    ])
    expect(score(5, 35)).toEqual([]) // 5 of 30
    expect(score(4, 9)).toEqual([]) // 4 of 5: under the minimum count
  })

  it('needs at least five roles AND two percent across the board', () => {
    const spread = (n: number) =>
      Array.from({ length: n }, (_, i) => job('mistral', 'added', `Dept ${i}`))
    const sizes = (n: number, other: number) =>
      board(
        Object.fromEntries([
          ...Array.from({ length: n }, (_, i) => [`Dept ${i}`, 10]),
          ['Other', other],
        ]),
      )
    expect(scoreBoard('mistral', spread(2), sizes(2, 0), clusters).material).toEqual([]) // +2 of 18
    expect(scoreBoard('mistral', spread(5), sizes(5, 0), clusters).material).toContainEqual({
      kind: 'board',
      net: 5,
      before: 45,
    })
    expect(scoreBoard('openai', spread(9), sizes(9, 700), clusters).material).toEqual([]) // +9 of 781
  })

  it('reads a department opening or going dark, never the no-department bucket', () => {
    const opened = scoreBoard(
      'xai',
      many(3, () => job('xai', 'added', 'Robotics')),
      board({ Robotics: 3, Other: 300 }),
      clusters,
    )
    expect(opened.material).toEqual([{ kind: 'opened', department: 'Robotics', now: 3 }])
    const closed = scoreBoard(
      'xai',
      many(3, () => job('xai', 'removed', 'Kitchen')),
      board({ Other: 300 }),
      clusters,
    )
    expect(closed.material).toEqual([{ kind: 'closed', department: 'Kitchen', before: 3 }])
    const unlabelled = scoreBoard(
      'xai',
      many(3, () => job('xai', 'removed', null)),
      board({ Other: 300 }),
      clusters,
    )
    expect(unlabelled.departments[0]!.department).toBe(NO_DEPARTMENT)
    expect(unlabelled.material).toEqual([])
  })

  it('scores the physical-infrastructure cluster against its own size', () => {
    const anthropic = scoreBoard(
      'anthropic',
      many(6, () => job('anthropic', 'removed', 'Compute')),
      board({ Compute: 21, Other: 650 }),
      clusters,
    )
    expect(anthropic.material).toContainEqual({
      kind: 'cluster',
      cluster: 'Physical infrastructure',
      net: -6,
      before: 27,
    })
    // xAI's data-center cluster is half its board: three roles is churn there.
    const xai = scoreBoard(
      'xai',
      many(3, () => job('xai', 'added', 'Data Center')),
      board({ 'Data Center': 158, Other: 145 }),
      clusters,
    )
    expect(xai.material).toEqual([])
    const xaiBig = scoreBoard(
      'xai',
      many(8, () => job('xai', 'added', 'Data Center')),
      board({ 'Data Center': 163, Other: 145 }),
      clusters,
    )
    expect(xaiBig.material).toContainEqual({
      kind: 'cluster',
      cluster: 'Physical infrastructure',
      net: 8,
      before: 155,
    })
  })

  it('never counts a relabel between departments', () => {
    const moves = many(7, () => job('xai', 'modified', 'Data Center', undefined, 'Operations'))
    const out = scoreBoard('xai', moves, board({ Operations: 11, 'Data Center': 150 }), clusters)
    expect(out).toMatchObject({ added: 0, removed: 0, net: 0, departments: [], material: [] })
  })
})

// ---- D1: sizes, the submit gate, the roll-up ------------------------------

async function seedBoard(provider: string, sizes: Record<string, number>) {
  const rows = Object.entries(sizes).flatMap(([department, n]) =>
    Array.from({ length: n }, (_, i) => ({
      source_id: `${provider}-board`,
      entity_key: `job:${provider}:seed-${department}-${i}`,
      entity_type: 'job',
      provider,
      content_hash: contentHash({ provider, department, i }),
      payload: JSON.stringify({ department, title: `Seed ${i}` }),
      snapshot_id: 'seed',
      first_seen_at: '2026-08-01T00:00:00.000Z',
      source_url: URL_XAI,
      fetched_at: '2026-08-01T00:00:00.000Z',
    })),
  )
  for (let i = 0; i < rows.length; i += 10)
    await db.insert(schema.entities).values(rows.slice(i, i + 10))
}

/** Store job changes and make the entity set agree with them. */
async function storeJobs(changes: readonly ChangeRow[]) {
  await insertRows(db, 'changes', changes)
  for (const c of changes) {
    if (c.change_type !== 'added') continue
    await db.insert(schema.entities).values({
      source_id: `${c.provider}-board`,
      entity_key: c.entity_key,
      entity_type: 'job',
      provider: c.provider,
      content_hash: c.after_hash!,
      payload: c.after_json!,
      snapshot_id: 'after',
      first_seen_at: c.detected_at,
      source_url: c.source_url,
      fetched_at: c.fetched_at,
    })
  }
}

beforeEach(async () => {
  await db.delete(schema.alerts)
  await db.delete(schema.changes)
  await db.delete(schema.entities)
  await db.delete(schema.judgeRuns)
  await db.delete(schema.socialPosts)
})

describe('boardMoves', () => {
  it('scores against the board right after the changes, undoing later ones', async () => {
    await seedBoard('xai', { 'Human Data': 2, Model: 20 })
    const cut = many(12, () => job('xai', 'removed', 'Human Data', '2026-11-03T18:00:00.000Z'))
    const later = many(4, () => job('xai', 'added', 'Human Data', '2026-11-04T00:00:00.000Z'))
    await storeJobs([...cut, ...later])

    const [move] = await boardMoves(db, cut, clusters)
    expect(move).toMatchObject({ provider: 'xai', net: -12, before: 34, now: 22 })
    expect(move!.departments[0]).toMatchObject({ department: 'Human Data', before: 14, now: 2 })

    const pending = await hiringBoards(db, [...cut, ...later], clusters)
    expect(pending.boards[0]).toMatchObject({ provider: 'xai', net: -8, board_now: 26 })
    expect(pending.boards[0]!.material).toContain('Human Data −8 of 14')
  })
})

describe('the submit gate', () => {
  const T = '2026-11-03T18:00:00.000Z'
  const submit = (alerts: unknown[], seen: readonly ChangeRow[]) =>
    submitJudgeRun(
      db,
      JSON.stringify({ alerts, judged_through: T, change_ids_seen: seen.map((c) => c.id) }),
      { clusters, now: new Date('2026-11-03T19:00:00Z') },
    )
  const alert = (severity: string, headline: string, cited: readonly ChangeRow[]) => ({
    severity,
    headline,
    explanation: 'Roles on the board moved.',
    change_ids: cited.map((c) => c.id),
  })

  it('clamps a below-floor hiring alert to info, whatever the routine sent', async () => {
    await seedBoard('anthropic', { Sales: 90, Other: 470 })
    const churn = [job('anthropic', 'added', 'Sales', T), job('anthropic', 'added', 'Sales', T)]
    await storeJobs(churn)

    const report = await submit(
      [
        alert('critical', 'Anthropic adds Sales roles', churn),
        alert('notable', 'Anthropic Sales hiring', churn),
      ],
      churn,
    )
    expect(report.accepted).toBe(2)
    expect(report.clamped).toEqual([
      {
        headline: 'Anthropic adds Sales roles',
        from: 'critical',
        to: 'info',
        detail: 'below the hiring materiality floor (anthropic net +2 on a board of 560)',
      },
      {
        headline: 'Anthropic Sales hiring',
        from: 'notable',
        to: 'info',
        detail: 'below the hiring materiality floor (anthropic net +2 on a board of 560)',
      },
    ])
    const stored = await db.select().from(schema.alerts)
    expect(stored.map((a) => a.severity)).toEqual(['info', 'info'])
  })

  it('keeps a material move at the severity sent, and never raises one', async () => {
    await seedBoard('xai', { 'Human Data': 2, Other: 280 })
    const cut = many(12, () => job('xai', 'removed', 'Human Data', T))
    await storeJobs(cut)

    const report = await submit(
      [
        alert('notable', 'xAI pulls Human Data postings', cut),
        alert('info', 'xAI Human Data roles close', cut),
      ],
      cut,
    )
    expect(report.clamped).toEqual([])
    const stored = await db.select().from(schema.alerts)
    expect(stored.map((a) => a.severity).sort()).toEqual(['info', 'notable'])
  })

  it('lowers a critical cut to notable while the department still has open roles', async () => {
    await seedBoard('xai', { 'Human Data': 2, Other: 280 })
    const cut = many(12, () => job('xai', 'removed', 'Human Data', T))
    await storeJobs(cut)

    const report = await submit([alert('critical', 'xAI pulls Human Data postings', cut)], cut)
    expect(report.clamped).toEqual([
      {
        headline: 'xAI pulls Human Data postings',
        from: 'critical',
        to: 'notable',
        detail: 'a cut that empties no department (xai net −12 on a board of 294)',
      },
    ])
    const [stored] = await db.select().from(schema.alerts)
    expect(stored?.severity).toBe('notable')
  })

  it('keeps a critical cut that empties a department', async () => {
    await seedBoard('xai', { Other: 280 })
    const cut = many(12, () => job('xai', 'removed', 'Human Data', T))
    await storeJobs(cut)

    const report = await submit([alert('critical', 'xAI closes Human Data', cut)], cut)
    expect(report.clamped).toEqual([])
    const [stored] = await db.select().from(schema.alerts)
    expect(stored?.severity).toBe('critical')
  })

  it('keeps a critical hiring surge, which is not a cut', async () => {
    await seedBoard('anthropic', { Finance: 30, Other: 600 })
    const surge = many(10, () => job('anthropic', 'added', 'Finance', T))
    await storeJobs(surge)

    const report = await submit([alert('critical', 'Anthropic staffs up Finance', surge)], surge)
    expect(report.clamped).toEqual([])
    const [stored] = await db.select().from(schema.alerts)
    expect(stored?.severity).toBe('critical')
  })

  it('leaves a cross-axis alert and an alert citing only relabels to their own rules', async () => {
    await seedBoard('xai', { 'Data Center': 150 })
    const relabel = many(6, () => job('xai', 'modified', 'Data Center', T, 'Operations'))
    const hire = job('xai', 'added', 'Sales', T)
    const price = ChangeRow.parse({
      ...hire,
      id: contentHash({ price: 1 }),
      entity_key: 'model:xai:grok-4.6:standard',
      entity_type: 'model',
      change_type: 'added',
      after_json: JSON.stringify({ model_slug: 'grok-4.6' }),
    })
    await storeJobs([...relabel, hire])
    await insertRows(db, 'changes', [price])

    const report = await submit(
      [
        alert('notable', 'xAI moves roles to Operations', relabel),
        alert('notable', 'xAI adds grok-4.6 and a Sales role', [hire, price]),
      ],
      [...relabel, hire, price],
    )
    expect(report.clamped.map((c) => [c.headline, c.detail])).toEqual([
      [
        'xAI moves roles to Operations',
        'below the hiring materiality floor (no role added or removed)',
      ],
    ])
  })
})

describe('the weekly roll-up', () => {
  const NOW = new Date('2026-11-09T13:00:00Z') // Monday, the cron's tick

  it('rolls up the Monday-to-Monday week before the one now falls in', () => {
    expect(lastCompleteWeek(NOW)).toEqual({
      start: '2026-11-02T00:00:00.000Z',
      end: '2026-11-09T00:00:00.000Z',
    })
    expect(lastCompleteWeek(new Date('2026-11-08T23:59:59Z')).start).toBe(
      '2026-10-26T00:00:00.000Z',
    )
  })

  it('writes one alert per lab, notable only above the floor, never critical, citing every role', async () => {
    await seedBoard('xai', { 'Human Data': 2, Other: 280 })
    await seedBoard('anthropic', { Sales: 90, Other: 470 })
    const xai = [
      ...many(6, () => job('xai', 'removed', 'Human Data', '2026-11-03T06:00:00.000Z')),
      ...many(6, () => job('xai', 'removed', 'Human Data', '2026-11-05T06:00:00.000Z')),
      job('xai', 'added', 'Model', '2026-11-06T06:00:00.000Z'),
    ]
    const anthropic = [
      job('anthropic', 'added', 'Sales', '2026-11-04T00:00:00.000Z'),
      job('anthropic', 'removed', 'Sales', '2026-11-04T00:00:00.000Z'),
    ]
    const outside = [
      job('anthropic', 'added', 'Sales', '2026-11-01T23:59:00.000Z'),
      job('anthropic', 'added', 'Sales', '2026-11-09T00:00:00.000Z'),
    ]
    const relabel = job('xai', 'modified', 'Model', '2026-11-04T00:00:00.000Z', 'Research')
    await storeJobs([...xai, ...anthropic, ...outside, relabel])

    const alerts = await hiringRollupAlerts(db, clusters, NOW)
    expect(alerts.map((a) => [a.headline, a.severity, a.rule])).toEqual([
      [
        'Anthropic hiring, week of 2026-11-02: net 0 (1 added, 1 closed)',
        'info',
        HIRING_ROLLUP_RULE,
      ],
      [
        'xAI hiring, week of 2026-11-02: net −11 (1 added, 12 closed); Human Data −12, Model +1',
        'notable',
        HIRING_ROLLUP_RULE,
      ],
    ])
    const [, xaiAlert] = alerts
    expect(JSON.parse(xaiAlert!.change_ids)).toEqual(xai.map((c) => c.id).sort())
    expect(xaiAlert!.created_at).toBe('2026-11-06T06:00:00.000Z')
    expect(xaiAlert!.explanation).toContain('Human Data −12 (14 to 2)')
    expect(xaiAlert!.explanation).toContain(
      'Above the hiring materiality floor: net −11 on a board of 294; Human Data −12 of 14.',
    )

    expect(await writeHiringRollups(db, clusters, NOW)).toEqual({
      week: '2026-11-02',
      inserted: 2,
      notable: 1,
    })
    expect(await writeHiringRollups(db, clusters, NOW)).toEqual({
      week: '2026-11-02',
      inserted: 0,
      notable: 0,
    })
    const stored = await db.select().from(schema.alerts)
    expect(stored.every((a) => a.severity !== 'critical')).toBe(true)

    // The social layer queues critical alerts only: a roll-up is never posted.
    const channels = { x: 'chan-x', bluesky: 'chan-bsky' }
    expect(await enqueueCriticalAlerts(db, channels, 'https://frontierterm.com')).toBe(0)
  })

  it('writes nothing for a week with no role added or closed', async () => {
    await seedBoard('xai', { Model: 10 })
    await storeJobs([job('xai', 'modified', 'Model', '2026-11-04T00:00:00.000Z', 'Research')])
    expect(await hiringRollupAlerts(db, clusters, NOW)).toEqual([])
  })
})
