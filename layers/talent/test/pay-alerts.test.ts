import { beforeEach, describe, expect, it } from 'vitest'

import { PAY_RULE, payMove, writePayAlerts } from '../server/pipeline/pay-alerts'
import { JUDGE_EXCLUDED_ENTITY_TYPES } from '#layers/core/server/pipeline/judge/pending'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const START = Date.parse('2026-11-04T00:00:00Z')
/** One daily median per value, from 2026-11-04. */
const series = (values: number[], roles = 50) =>
  values.map((value, i) => ({ date: iso(START + i * DAY), value, roles }))

describe('the posted-pay rule, pure', () => {
  const flat = Array<number>(7).fill(370_000)

  it('alerts on a sustained move of 5% or more over the week before', () => {
    const move = payMove(series([...flat, ...Array<number>(7).fill(397_500)]), '2026-11-17')!
    expect(move).toMatchObject({ before: 370_000, after: 397_500, roles: 50 })
    expect(move.pct).toBeCloseTo(7.43, 1)
  })

  it('does not alert on a cell that flips back and forth, or a move under 5%', () => {
    const flip = [505, 505, 505, 505, 475, 475, 475, 445, 445, 475, 475, 475, 505, 505].map(
      (n) => n * 1000,
    )
    expect(payMove(series(flip), '2026-11-17')).toBeNull()
    expect(payMove(series([...flat, ...Array<number>(7).fill(380_000)]), '2026-11-17')).toBeNull()
  })

  it('needs 14 days of history and 30 bands behind the cell', () => {
    const wk = [...flat, ...Array<number>(7).fill(397_500)]
    expect(payMove(series(wk.slice(2)), '2026-11-17')).toBeNull()
    expect(payMove(series(wk, 20), '2026-11-17')).toBeNull()
  })

  it('carries the last stored day over a day the recipe stored nothing', () => {
    const days = series([...flat, ...Array<number>(7).fill(397_500)]).filter(
      (d) => d.date !== '2026-11-15',
    )
    expect(payMove(days, '2026-11-17')).not.toBeNull()
  })
})

async function seed(values: number[], key = 'research') {
  for (const [i, value] of values.entries()) {
    const date = iso(START + i * DAY)
    await db.insert(schema.recipeObservations).values({
      id: `pay-openai:${key}:${date}`,
      recipe_id: 'pay-openai',
      company: 'openai',
      key,
      date,
      value,
      payload: JSON.stringify({
        n: 53,
        p25: 283_500,
        p75: 440_000,
        roles_on_board: 800,
        departments: ['Research'],
      }),
      raw_key: 'recipes/pay-openai/x.json',
      first_seen_at: `${date}T06:00:00.000Z`,
      source_url: 'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true',
      fetched_at: `${date}T06:00:00.000Z`,
    })
  }
}

describe('the posted-pay rule over a seeded store', () => {
  beforeEach(async () => {
    for (const t of [schema.alerts, schema.changes, schema.recipeObservations]) await db.delete(t)
  })

  it('alerts once on a lasting move, even as the window slides over it', async () => {
    await seed([...Array<number>(7).fill(370_500), ...Array<number>(10).fill(397_500)])
    expect(await writePayAlerts(db, new Date('2026-11-17T12:00:00Z'))).toEqual({
      written: 1,
      findings: 1,
    })
    const [alert] = await db.select().from(schema.alerts)
    expect(alert).toMatchObject({ rule: PAY_RULE, severity: 'notable' })
    expect(alert!.headline).toBe(
      'OpenAI’s posted pay for research roles rises 7.3% in a week, to a $398K median from $371K',
    )
    const [change] = await db.select().from(schema.changes)
    expect(change).toMatchObject({ entity_type: 'pay_band', provider: 'openai' })
    // The next days: the windows still differ, and it is already said.
    expect((await writePayAlerts(db, new Date('2026-11-17T18:00:00Z'))).written).toBe(0)
    expect((await writePayAlerts(db, new Date('2026-11-18T12:00:00Z'))).written).toBe(0)
    expect((await db.select().from(schema.alerts)).length).toBe(1)
  })

  it('writes nothing from a board that moved 3%, or from fewer than 14 days of it', async () => {
    await seed([...Array<number>(7).fill(370_500), ...Array<number>(7).fill(380_000)])
    expect((await writePayAlerts(db, new Date('2026-11-17T12:00:00Z'))).written).toBe(0)
    await db.delete(schema.recipeObservations)
    await seed([...Array<number>(5).fill(370_500), ...Array<number>(5).fill(397_500)])
    expect((await writePayAlerts(db, new Date('2026-11-13T12:00:00Z'))).written).toBe(0)
  })

  it('keeps its rows from the judge', () => {
    expect(JUDGE_EXCLUDED_ENTITY_TYPES).toContain('pay_band')
  })
})
