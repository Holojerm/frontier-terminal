import { beforeEach, describe, expect, it } from 'vitest'

import {
  DATACENTER_RULE,
  siteChanges,
  writeDatacenterAlerts,
} from '../server/pipeline/datacenter-alerts'
import { JUDGE_EXCLUDED_ENTITY_TYPES } from '#layers/core/server/pipeline/judge/pending'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

const site = (name: string, mw: number, users = 'OpenAI #confident') => ({
  name,
  mw,
  h100e: mw * 700,
  owner: 'Oracle',
  users,
  country: 'United States',
  source_url: 'https://epoch.ai/data/data_centers/data_centers.csv',
  fetched_at: '2026-11-23T06:00:00.000Z',
})

describe('the data-center rule, pure', () => {
  it('flags a new site of 100 MW or more and a power move of 25% and 50 MW or more', () => {
    const earlier = [site('A', 200), site('B', 80), site('C', 100), site('D', 600)]
    const later = [
      site('A', 200),
      site('B', 140), // +75%, +60 MW: moved
      site('C', 110), // +10%: noise
      site('D', 630), // +50 MW but 5%: noise
      site('New big', 300),
      site('New small', 40),
    ]
    expect(siteChanges(earlier, later).map((c) => [c.kind, c.site.name])).toEqual([
      ['power', 'B'],
      ['new', 'New big'],
    ])
  })

  it('does not read a removal or a rename as news, nor a 40 MW swing on a small site as a move', () => {
    expect(siteChanges([site('Old name', 300), site('S', 40)], [site('New name', 305), site('S', 80)])).toEqual([])
    expect(siteChanges([site('Gone', 300)], [])).toEqual([])
  })
})

async function seed(date: string, sites: ReturnType<typeof site>[]) {
  for (const s of sites) {
    await db.insert(schema.recipeObservations).values({
      id: `epoch:${s.name}:${date}`,
      recipe_id: 'epoch-data-centers',
      company: 'frontier-labs',
      key: s.name,
      date,
      value: s.mw,
      payload: JSON.stringify({
        h100e: s.h100e,
        owner: s.owner,
        users: s.users,
        country: s.country,
        capital_cost_busd: null,
        project: '',
        chips: '',
      }),
      raw_key: 'recipes/epoch-data-centers/x.csv',
      first_seen_at: `${date}T06:00:00.000Z`,
      source_url: s.source_url,
      fetched_at: `${date}T06:00:00.000Z`,
    })
  }
}

describe('the data-center rule over a seeded store', () => {
  beforeEach(async () => {
    for (const t of [schema.alerts, schema.changes, schema.recipeObservations]) await db.delete(t)
  })

  it('alerts once per changed site, on the compute topic, and not again', async () => {
    await seed('2026-11-18', [site('Abilene', 800), site('Aiken', 70)])
    await seed('2026-11-23', [site('Abilene', 800), site('Aiken', 130), site('Stargate Michigan', 400)])
    const now = new Date('2026-11-23T12:00:00Z')
    expect(await writeDatacenterAlerts(db, now)).toEqual({ written: 2, findings: 2 })
    const alerts = await db.select().from(schema.alerts)
    expect(alerts.map((a) => [a.rule, a.severity, a.headline]).sort()).toEqual([
      [DATACENTER_RULE, 'notable', 'Epoch AI adds a 400 MW data center in United States: Stargate Michigan'],
      [DATACENTER_RULE, 'notable', 'Epoch AI raises Aiken to 130 MW from 70 MW (86%)'],
    ])
    const changes = await db.select().from(schema.changes)
    expect(changes.map((c) => [c.entity_type, c.change_type, c.provider]).sort()).toEqual([
      ['data_center', 'added', 'openai'],
      ['data_center', 'modified', 'openai'],
    ])
    const ctx = queryContext(fixtureText('sources.yaml'), null, () => now)
    const feed = await queryAlerts(db, ctx, 20, 'alert', { topic: 'compute' })
    expect(feed.rows).toHaveLength(2)
    expect(feed.rows.flatMap((a) => a.changes.map((c) => c.summary)).sort()).toEqual([
      'Aiken data center · 130 MW · 2026-11-23',
      'Stargate Michigan data center · 400 MW · 2026-11-23',
    ])
    // Re-running on the same reads writes nothing twice.
    expect((await writeDatacenterAlerts(db, now)).written).toBe(0)
    expect((await writeDatacenterAlerts(db, new Date('2026-11-24T06:00:00Z'))).written).toBe(0)
  })

  it('writes nothing from stored history that is not fresh, nor from a single snapshot', async () => {
    await seed('2026-11-18', [site('Aiken', 70)])
    await seed('2026-11-23', [site('Aiken', 130)])
    expect((await writeDatacenterAlerts(db, new Date('2026-12-10T12:00:00Z'))).written).toBe(0)
    await db.delete(schema.recipeObservations)
    await seed('2026-11-23', [site('Aiken', 130)])
    expect((await writeDatacenterAlerts(db, new Date('2026-11-23T12:00:00Z'))).written).toBe(0)
  })

  it('keeps its rows from the judge', () => {
    expect(JUDGE_EXCLUDED_ENTITY_TYPES).toContain('data_center')
  })
})
