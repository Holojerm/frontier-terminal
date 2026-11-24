import { beforeEach, describe, expect, it } from 'vitest'

import {
  ADOPTION_RULE,
  monthMove,
  weekMove,
  writeAdoptionAlerts,
} from '../server/pipeline/adoption-alerts'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Complete weeks from Monday 2026-08-31, one per total; the move is the last pair. */
const weeks = (totals: number[], extra: Partial<{ partial: boolean; retrospective: boolean }> = {}) =>
  totals.map((total, i) => ({
    week: iso(Date.parse('2026-08-31T00:00:00Z') + i * 7 * DAY),
    total,
    partial: false,
    retrospective: false,
    ...(i === totals.length - 1 ? extra : {}),
  }))

// Nine weeks ending Monday 2026-10-26; "now" is the Wednesday after, 2026-11-04... one week on.
const NOW = new Date('2026-11-04T12:00:00Z')
const calm = [100, 104, 99, 103, 98, 102, 105, 100]

describe('the adoption week rule, pure', () => {
  it('alerts on a week that is both 25% and far beyond the series’ own noise', () => {
    const move = weekMove(weeks([...calm.map((n) => n * 1e6), 140e6]), NOW)!
    expect(move).toMatchObject({ week: '2026-10-26', before: 100e6, after: 140e6 })
    expect(move.pct).toBeCloseTo(40)
  })

  it('stays quiet below 25%, or when the series always swings that far', () => {
    expect(weekMove(weeks([...calm.map((n) => n * 1e6), 120e6]), NOW)).toBeNull()
    const jumpy = [100, 140, 95, 150, 90, 130, 100, 140].map((n) => n * 1e6)
    expect(weekMove(weeks([...jumpy, 190e6]), NOW)).toBeNull()
  })

  it('does not compare a partial week, a retrospective week, or too little history', () => {
    const wk = [...calm.map((n) => n * 1e6), 140e6]
    expect(weekMove(weeks(wk, { partial: true }), NOW)).toBeNull()
    expect(weekMove(weeks(wk, { retrospective: true }), NOW)).toBeNull()
    expect(weekMove(weeks([100e6, 100e6, 100e6, 140e6]), NOW)).toBeNull()
    // Seven weeks old: the series has gone quiet, not moved.
    expect(weekMove(weeks(wk), new Date('2026-12-20T00:00:00Z'))).toBeNull()
  })

  it('reads a Ramp month against its own monthly moves, in points', () => {
    const month = (i: number) => `${2026 + Math.floor((i + 0) / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`
    const flat = [40, 40.4, 40.1, 40.6, 40.3, 40.7, 40.5].map((value, i) => ({ month: month(i), value }))
    const up = [...flat, { month: month(7), value: 43.2 }]
    expect(monthMove(up)).toMatchObject({ month: '2026-08-01', before: 40.5 })
    expect(monthMove([...flat, { month: month(7), value: 41.5 }])).toBeNull()
    // A skipped month is a gap, not a move.
    expect(monthMove([...flat, { month: month(9), value: 46 }])).toBeNull()
  })
})

// ---- over a seeded store ---------------------------------------------------------------

async function seedDays(recipe_id: string, key: string, from: string, days: number, perDay: (i: number) => number) {
  const start = Date.parse(`${from}T00:00:00Z`)
  for (let i = 0; i < days; i++) {
    const date = iso(start + i * DAY)
    await db.insert(schema.recipeObservations).values({
      id: `${recipe_id}:${date}`,
      recipe_id,
      company: 'openai',
      key,
      date,
      value: perDay(i),
      payload: '{}',
      raw_key: `recipes/${recipe_id}/x.json`,
      first_seen_at: `${date}T06:00:00.000Z`,
      source_url: 'https://api.npmjs.org/downloads/range/openai',
      fetched_at: `${date}T06:00:00.000Z`,
    })
  }
}

const stored = async () => ({
  alerts: await db.select().from(schema.alerts),
  changes: await db.select().from(schema.changes),
})

describe('the adoption rule over a seeded store', () => {
  beforeEach(async () => {
    for (const t of [schema.alerts, schema.changes, schema.recipeObservations]) await db.delete(t)
  })

  // Mon 2026-08-31 .. Sun 2026-11-01 is nine weeks; the ninth carries the jump.
  const jump = (i: number) => (i < 56 ? [100, 104, 99, 103, 98, 102, 105, 100][Math.floor(i / 7)]! : 140) * 1000

  it('writes one alert for the jump, and nothing on a re-run', async () => {
    await seedDays('npm-openai', 'openai', '2026-08-31', 63, jump)
    const now = new Date('2026-11-03T12:00:00Z')
    expect(await writeAdoptionAlerts(db, now)).toMatchObject({ written: 1 })
    const rows = await stored()
    expect(rows.alerts).toHaveLength(1)
    expect(rows.alerts[0]).toMatchObject({ rule: ADOPTION_RULE, severity: 'notable' })
    expect(rows.alerts[0]!.headline).toBe(
      'openai npm downloads rise 40% in the week to 2026-11-01, to 980,000 from 700,000',
    )
    expect(rows.changes.map((c) => [c.entity_type, c.entity_key, c.provider])).toEqual([
      ['adoption_series', 'adoption_series:npm-openai', 'openai'],
    ])
    // The same tick again, and a later tick over the same weeks: already said.
    expect((await writeAdoptionAlerts(db, now)).written).toBe(0)
    expect((await writeAdoptionAlerts(db, new Date('2026-11-04T06:00:00Z'))).written).toBe(0)
    expect((await stored()).alerts).toHaveLength(1)
  })

  it('writes nothing for a series whose history ends long ago: a backfill is not news', async () => {
    await seedDays('npm-openai', 'openai', '2026-08-31', 63, jump)
    expect((await writeAdoptionAlerts(db, new Date('2026-12-30T12:00:00Z'))).written).toBe(0)
    expect((await stored()).alerts).toEqual([])
  })

  it('ignores a flat series', async () => {
    await seedDays('npm-openai', 'openai', '2026-08-31', 63, () => 100_000)
    expect((await writeAdoptionAlerts(db, new Date('2026-11-03T12:00:00Z'))).written).toBe(0)
  })

  it('writes an alert for a Ramp vendor’s month, once, and only while the release is fresh', async () => {
    const months = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']
    const share = [2.0, 2.2, 2.1, 2.4, 2.3, 2.6, 2.7, 5.1]
    for (const [i, date] of months.entries()) {
      await db.insert(schema.recipeObservations).values({
        id: `ramp:xai:${date}`,
        recipe_id: 'ramp-ai-index',
        company: 'frontier-labs',
        key: 'xai',
        date,
        value: share[i]!,
        payload: JSON.stringify({ vendor: 'xAI', mom_change_pp: null, data_version: 'v' }),
        raw_key: 'recipes/ramp-ai-index/x.html',
        first_seen_at: '2026-11-19T18:00:00.000Z',
        source_url: 'https://ramp.com/data/ai-index',
        fetched_at: '2026-11-19T18:00:00.000Z',
      })
    }
    expect((await writeAdoptionAlerts(db, new Date('2026-12-30T12:00:00Z'))).written).toBe(0)
    const now = new Date('2026-11-23T12:00:00Z')
    expect((await writeAdoptionAlerts(db, now)).written).toBe(1)
    expect((await writeAdoptionAlerts(db, now)).written).toBe(0)
    const { alerts, changes } = await stored()
    expect(alerts[0]!.headline).toBe(
      'xAI adoption among Ramp businesses rises 2.4 points in October 2026, to 5.1% from 2.7%',
    )
    expect(changes[0]).toMatchObject({ provider: 'xai', entity_type: 'adoption_series' })
  })
})
