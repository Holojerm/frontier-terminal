import { beforeEach, describe, expect, it } from 'vitest'

import { LIMITS_RULE, limitMoves, writeLimitsAlerts } from '../server/pipeline/limits-alerts'
import { JUDGE_EXCLUDED_ENTITY_TYPES } from '#layers/core/server/pipeline/judge/pending'

const row = (model: string, tier: string, metric: string, value: number | null, date: string) => ({
  id: `${model}|${tier}|${metric}|${date}`,
  recipe_id: 'limits-anthropic',
  company: 'anthropic',
  key: `${model}|${tier}|${metric}`,
  date,
  value,
  payload: JSON.stringify({ model, tier, metric }),
  raw_key: 'recipes/limits-anthropic/x.md',
  first_seen_at: `${date}T06:00:00.000Z`,
  source_url: 'https://docs.example/rate-limits',
  fetched_at: `${date}T06:00:00.000Z`,
})

const snapshot = (date: string, limits: [string, string, string, number | null][]) =>
  limits.map(([m, t, k, v]) => row(m, t, k, v, date))

describe('the rate-limit rule, pure', () => {
  const earlier = snapshot('2026-11-10', [
    ['Claude A', 'Tier 1', 'RPM', 50],
    ['Claude A', 'Tier 4', 'RPM', 4000],
    ['Claude A', 'Tier 4', 'ITPM', 2_000_000],
    ['Claude B', 'Tier 1', 'RPM', 50],
    ['Claude C', 'Tier 1', 'RPM', 50],
    ['Claude D', 'Tier 1', 'RPM', 50],
  ])

  it('groups moves of 10% or more by model, and counts to or from no limit', () => {
    const later = snapshot('2026-11-20', [
      ['Claude A', 'Tier 1', 'RPM', 100], // doubled
      ['Claude A', 'Tier 4', 'RPM', 4200], // +5%: noise
      ['Claude A', 'Tier 4', 'ITPM', 2_000_000],
      ['Claude B', 'Tier 1', 'RPM', null], // no limit any more
      ['Claude C', 'Tier 1', 'RPM', 50],
    ])
    const moves = limitMoves(earlier, later)
    expect([...moves.keys()]).toEqual(['Claude A', 'Claude B'])
    expect(moves.get('Claude A')).toEqual([
      { model: 'Claude A', tier: 'Tier 1', metric: 'RPM', before: 50, after: 100 },
    ])
  })

  it('ignores a model or tier that is in only one snapshot', () => {
    const later = snapshot('2026-11-20', [
      ['Claude A', 'Tier 1', 'RPM', 50],
      ['Claude Z', 'Tier 1', 'RPM', 9999],
      ['Claude B', 'Tier 9', 'RPM', 9999],
    ])
    expect(limitMoves(earlier, later).size).toBe(0)
  })
})

async function seed(date: string, limits: [string, string, string, number | null][]) {
  for (const r of snapshot(date, limits)) await db.insert(schema.recipeObservations).values(r)
}

describe('the rate-limit rule over a seeded store', () => {
  beforeEach(async () => {
    for (const t of [schema.alerts, schema.changes, schema.recipeObservations]) await db.delete(t)
  })

  it('writes one alert per model for a cut, and not again', async () => {
    await seed('2026-11-10', [
      ['Claude A', 'Tier 4', 'RPM', 4000],
      ['Claude A', 'Tier 4', 'ITPM', 2_000_000],
      ['Claude B', 'Tier 4', 'RPM', 4000],
    ])
    await seed('2026-11-20', [
      ['Claude A', 'Tier 4', 'RPM', 2000],
      ['Claude A', 'Tier 4', 'ITPM', 1_000_000],
      ['Claude B', 'Tier 4', 'RPM', 4000],
    ])
    const now = new Date('2026-11-20T12:00:00Z')
    expect(await writeLimitsAlerts(db, now)).toEqual({ written: 1, findings: 1 })
    const [alert] = await db.select().from(schema.alerts)
    expect(alert).toMatchObject({ rule: LIMITS_RULE, severity: 'notable' })
    expect(alert!.headline).toBe('Anthropic changes Claude A rate limits on 2 tier-and-metric limits (0 up, 2 down)')
    expect(alert!.explanation).toContain('Tier 4 RPM 4,000 to 2,000; Tier 4 ITPM 2,000,000 to 1,000,000')
    const [change] = await db.select().from(schema.changes)
    expect(change).toMatchObject({ entity_type: 'rate_limit', provider: 'anthropic' })
    expect((await writeLimitsAlerts(db, now)).written).toBe(0)
    expect((await writeLimitsAlerts(db, new Date('2026-11-21T06:00:00Z'))).written).toBe(0)
  })

  it('writes nothing when a re-fetch left every limit as it was, or a model was renamed', async () => {
    await seed('2026-11-10', [['Claude X.x', 'Tier 4', 'RPM', 4000]])
    await seed('2026-11-20', [['Claude X.2', 'Tier 4', 'RPM', 4000]])
    expect((await writeLimitsAlerts(db, new Date('2026-11-20T12:00:00Z'))).written).toBe(0)
    await db.delete(schema.recipeObservations)
    await seed('2026-11-19', [['Claude A', 'Tier 4', 'RPM', 4000]])
    await seed('2026-11-20', [['Claude A', 'Tier 4', 'RPM', 4000]])
    expect((await writeLimitsAlerts(db, new Date('2026-11-20T12:00:00Z'))).written).toBe(0)
  })

  it('writes nothing for a change in stored history that is not fresh', async () => {
    await seed('2026-11-04', [['Claude A', 'Tier 4', 'RPM', 4000]])
    await seed('2026-11-06', [['Claude A', 'Tier 4', 'RPM', 2000]])
    expect((await writeLimitsAlerts(db, new Date('2026-11-23T12:00:00Z'))).written).toBe(0)
  })

  it('keeps its rows from the judge', () => {
    expect(JUDGE_EXCLUDED_ENTITY_TYPES).toContain('rate_limit')
  })
})
