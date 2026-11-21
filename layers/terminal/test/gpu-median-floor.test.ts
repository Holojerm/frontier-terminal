import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { ChangeRow } from '#layers/core/server/pipeline/contracts'
import {
  GPU_MEDIAN_RULE,
  gpuMedianAlert,
  headlineFor,
  medianMove,
  moveTier,
  writeGpuMedianAlerts,
} from '../server/pipeline/gpu-median-floor'
import { JUDGE_EXCLUDED_ENTITY_TYPES } from '#layers/core/server/pipeline/judge/pending'
import type { GpuObservation } from '../server/theses/recipes/gpu-series'
import { queryAlerts } from '../server/utils/terminal-alerts'
import { queryContext } from '#layers/core/server/utils/terminal-db'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

const o = (
  provider: string,
  key: string,
  value: number,
  extra: Partial<GpuObservation> = {},
): GpuObservation => ({
  provider,
  key,
  gpu: 'H100',
  counted: true,
  value,
  date: '2026-11-20',
  source_url: `https://${provider}.example/pricing`,
  fetched_at: '2026-11-20T06:00:00.000Z',
  ...extra,
})

describe('the GPU median rule, pure', () => {
  it('tiers a move at 5% (notable) and 15% (critical), either way', () => {
    expect(moveTier(4.99)).toBeNull()
    expect(moveTier(-5)).toBe('notable')
    expect(moveTier(14.9)).toBe('notable')
    expect(moveTier(-15)).toBe('critical')
    expect(moveTier(40)).toBe('critical')
  })

  it('holds the providers and each provider’s configurations fixed across the two reads', () => {
    const earlier = [
      o('lambda', 'h100-sxm', 4, { date: '2026-11-13' }),
      o('coreweave', 'h100-hgx', 6, { date: '2026-11-13' }),
      o('nebius', 'h100-sxm', 3, { date: '2026-11-13' }),
      // Gone on the later read: out of both medians.
      o('crusoe', 'h100-sxm', 1, { date: '2026-11-13' }),
    ]
    const later = [
      o('lambda', 'h100-sxm', 4),
      // A region the page didn't list a week ago, priced far off: ignored.
      o('lambda', 'h100-sxm-new-region', 40),
      o('coreweave', 'h100-hgx', 5),
      o('nebius', 'h100-sxm', 3),
      // New since: out of both medians.
      o('verda', 'h100-sxm', 9),
      // PCIe cards and B200 rows aren't the H100 median's.
      o('nebius', 'h100-pcie', 1, { counted: false }),
      o('coreweave', 'b200', 1, { gpu: 'B200' }),
    ]
    const move = medianMove('H100', earlier, later)!
    expect(move.providers.map((p) => p.provider)).toEqual(['coreweave', 'lambda', 'nebius'])
    expect(move.before).toBe(4)
    expect(move.after).toBe(4)
    expect(move.pct).toBe(0)
    expect(move.providers.find((p) => p.provider === 'coreweave')).toMatchObject({
      before: 6,
      after: 5,
      configurations: 1,
      before_date: '2026-11-13',
      after_date: '2026-11-20',
    })
  })

  it('has no median under three providers in common: that is one provider’s price', () => {
    const earlier = [o('lambda', 'a', 4), o('coreweave', 'a', 6)]
    const later = [o('lambda', 'a', 3), o('coreweave', 'a', 4), o('nebius', 'a', 3)]
    expect(medianMove('H100', earlier, later)).toBeNull()
    expect(medianMove('B200', earlier, later)).toBeNull()
  })

  it('writes a notable alert citing one gpu_price row with both medians, and nothing under 5%', () => {
    const earlier = ['lambda', 'coreweave', 'nebius'].map((p, i) =>
      o(p, 'a', [4, 5, 6][i]!, { date: '2026-11-13' }),
    )
    const later = ['lambda', 'coreweave', 'nebius'].map((p, i) => o(p, 'a', [3.6, 4.5, 6][i]!))
    const move = medianMove('H100', earlier, later)!
    expect(move.pct).toBeCloseTo(-10)
    expect(headlineFor(move)).toBe(
      'H100 rental median falls 10% in 7 days, to $4.50 per GPU-hour from $5.00',
    )
    const now = new Date('2026-11-20T12:00:00Z')
    const { change, alert } = gpuMedianAlert(move, { now, through: '2026-11-13' })!
    expect(() => ChangeRow.parse(change)).not.toThrow()
    expect(change).toMatchObject({
      entity_type: 'gpu_price',
      entity_key: 'gpu_price:median:H100',
      provider: 'other',
      change_type: 'modified',
      detected_at: now.toISOString(),
    })
    const before = JSON.parse(change.before_json!)
    const after = JSON.parse(change.after_json!)
    expect(before).toMatchObject({ gpu: 'H100', as_of: '2026-11-13', median: 5 })
    expect(after).toMatchObject({
      as_of: '2026-11-20',
      median: 4.5,
      pct_change: -10,
      'usd.lambda': 3.6,
      providers: 'coreweave, lambda, nebius',
    })
    expect(alert).toMatchObject({
      severity: 'notable',
      rule: GPU_MEDIAN_RULE,
      change_ids: JSON.stringify([change.id]),
    })
    expect(alert.explanation).toContain('$5.00 per GPU-hour on 2026-11-13')
    expect(alert.explanation).toContain('Lambda $4.00 to $3.60 (−10%)')
    expect(alert.explanation).not.toContain('Nebius $')
    // The same day's move has the same ids, so a re-run writes nothing twice.
    expect(gpuMedianAlert(move, { now, through: '2026-11-13' })!.alert.id).toBe(alert.id)

    const small = medianMove('H100', earlier, [
      o('lambda', 'a', 4),
      o('coreweave', 'a', 4.8),
      o('nebius', 'a', 6),
    ])!
    expect(gpuMedianAlert(small, { now, through: '2026-11-13' })).toBeNull()
  })

  it('keeps its rows from the judge, which would otherwise write a second alert', () => {
    expect(JUDGE_EXCLUDED_ENTITY_TYPES).toContain('gpu_price')
  })
})

// ---- the rule over a seeded store ---------------------------------------------

const db = drizzle(env.DB, { schema })

const PROVIDERS = [
  ['gpu-lambda', 'lambda'],
  ['gpu-coreweave', 'coreweave'],
  ['gpu-nebius', 'nebius'],
  ['gpu-crusoe', 'crusoe'],
] as const

/** One read of every seeded provider on `date`, H100 at `prices` (one per provider). */
async function seedRead(date: string, prices: readonly number[], status = 'ok') {
  const at = `${date}T06:00:00.000Z`
  for (const [i, [recipe_id, company]] of PROVIDERS.entries()) {
    await db.insert(schema.recipeRuns).values({
      id: `${recipe_id}:${date}`,
      recipe_id,
      started_at: at,
      status,
      detail: status === 'failed' ? 'HTTP 500' : null,
      content_hash: null,
      observations: 1,
      source_url: `https://${company}.example/pricing`,
    })
    if (status === 'failed') continue
    await db.insert(schema.recipeObservations).values({
      id: `${recipe_id}:h100:${date}`,
      recipe_id,
      company,
      key: 'h100:sxm:8x',
      date,
      value: prices[i]!,
      payload: JSON.stringify({
        provider: company,
        gpu: 'H100',
        form_factor: 'SXM',
        counted: true,
        label: 'H100 SXM',
        gpus_per_instance: 8,
        instance_usd_per_hour: null,
        region: null,
        config: null,
      }),
      raw_key: `recipes/${recipe_id}/x.html`,
      first_seen_at: at,
      source_url: `https://${company}.example/pricing`,
      fetched_at: at,
    })
  }
}

const stored = async () => ({
  alerts: await db.select().from(schema.alerts),
  changes: await db.select().from(schema.changes),
})

describe('the GPU median rule over a seeded store', () => {
  beforeEach(async () => {
    for (const t of [schema.alerts, schema.changes, schema.recipeRuns, schema.recipeObservations]) {
      await db.delete(t)
    }
  })

  it('alerts once on a move, again only when it deepens to critical', async () => {
    await seedRead('2026-11-13', [4, 5, 6, 7])
    await seedRead('2026-11-20', [3.6, 4.5, 5.4, 6.3])
    const first = await writeGpuMedianAlerts(db, new Date('2026-11-20T12:00:00Z'))
    expect(first).toMatchObject({ skipped: null, written: 1 })
    expect(first.moves).toEqual([
      { gpu: 'H100', before: 5.5, after: 4.95, pct: expect.closeTo(-10), providers: 4 },
    ])
    let rows = await stored()
    expect(rows.alerts.map((a) => [a.severity, a.headline])).toEqual([
      ['notable', 'H100 rental median falls 10% in 7 days, to $4.95 per GPU-hour from $5.50'],
    ])
    expect(rows.changes.map((c) => c.entity_type)).toEqual(['gpu_price'])
    // On the compute topic of /alerts, with the median as the cited row's summary.
    const ctx = queryContext(
      fixtureText('sources.yaml'),
      null,
      () => new Date('2026-11-20T12:00:00Z'),
    )
    const feed = await queryAlerts(db, ctx, 20, 'alert', { topic: 'compute' })
    expect(feed.rows.map((a) => a.rule)).toEqual([GPU_MEDIAN_RULE])
    expect(feed.rows[0]!.changes[0]!.summary).toBe(
      'H100 rental median · $4.95 per GPU-hour · 4 providers · 2026-11-20',
    )
    expect((await queryAlerts(db, ctx, 20, 'alert', { topic: 'pricing' })).rows).toEqual([])

    // The same tick again, and the next day with no new prices: already said.
    await writeGpuMedianAlerts(db, new Date('2026-11-20T18:00:00Z'))
    expect((await writeGpuMedianAlerts(db, new Date('2026-11-21T12:00:00Z'))).written).toBe(0)
    expect((await stored()).alerts).toHaveLength(1)

    // Two days on the cut deepens past 15%: critical.
    await seedRead('2026-11-22', [3.2, 4, 4.8, 5.6])
    expect((await writeGpuMedianAlerts(db, new Date('2026-11-22T12:00:00Z'))).written).toBe(1)
    rows = await stored()
    expect(rows.alerts.map((a) => a.severity).sort()).toEqual(['critical', 'notable'])
  })

  it('skips a read where any provider’s newest run failed', async () => {
    await seedRead('2026-11-13', [4, 5, 6, 7])
    await seedRead('2026-11-20', [3, 3, 3, 3])
    await db.insert(schema.recipeRuns).values({
      id: 'gpu-crusoe:late',
      recipe_id: 'gpu-crusoe',
      started_at: '2026-11-20T11:00:00.000Z',
      status: 'failed',
      detail: 'HTTP 500',
      content_hash: null,
      observations: 0,
      source_url: 'https://crusoe.example/pricing',
    })
    const report = await writeGpuMedianAlerts(db, new Date('2026-11-20T12:00:00Z'))
    expect(report).toEqual({ skipped: 'failed: crusoe', written: 0, moves: [] })
    expect((await stored()).alerts).toEqual([])
  })

  it('writes nothing before there is a read seven days back', async () => {
    await seedRead('2026-11-18', [4, 5, 6, 7])
    await seedRead('2026-11-20', [3, 3, 3, 3])
    const report = await writeGpuMedianAlerts(db, new Date('2026-11-20T12:00:00Z'))
    expect(report.skipped).toBe('no prices stored for one of the two reads')
    expect((await stored()).alerts).toEqual([])
  })
})
