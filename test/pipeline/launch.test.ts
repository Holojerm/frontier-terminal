import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../../server/db/schema'
import type { SourceFetcher } from '../../server/pipeline/fetch'
import { checkLaunchCoverage, launchCoverage } from '../../server/pipeline/launch-watch'
import type { LockStore } from '../../server/pipeline/lock'
import { runRefresh, type RawStore } from '../../server/pipeline/refresh'
import { isPollInstant, runTripwire } from '../../server/pipeline/tripwire'
import { collectFleetCounters } from '../../server/utils/fleet-status'
import { fixtureText, manifest } from './fixtures'

// Launch day, end to end on the workerd D1/R2 bindings: a lab ships a model
// and rewrites its "start with" sentence, and the terminal has to (1) poll the
// catalog within minutes, (2) alert the new model without waiting on the
// judge, and (3) keep telling the owner about a matrix cell that still shows
// the old flagship. The rewrite is the Opus 5.5 launch of 2026-09-22.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}

const byUrl = new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))
const idToUrl = new Map(manifest.fixtures.map((f) => [f.source_id, f.source_url]))

function fetcher(overrides: Record<string, string> = {}): SourceFetcher & { calls: string[] } {
  const calls: string[] = []
  const fn = async (source: { source_id: string; url: string }) => {
    calls.push(source.source_id)
    const text = overrides[source.source_id] ?? byUrl.get(source.url)
    if (text === undefined) throw new Error(`no fixture for ${source.url}`)
    return { ok: true as const, status: 200, text, bytes: text.length }
  }
  return Object.assign(fn, { calls })
}

/** Keyed in-memory KV: the poll lock, the tripwire cooldowns and the watchdog markers. */
function memoryKv(): LockStore & { keys: Map<string, string> } {
  const keys = new Map<string, string>()
  return {
    keys,
    get: async (key) => keys.get(key) ?? null,
    put: async (key, value) => {
      keys.set(key, value)
    },
    delete: async (key) => {
      keys.delete(key)
    },
  }
}

let tick = 0
const clockAt = (iso: string) => {
  tick = Date.parse(iso)
  return () => new Date((tick += 1000))
}

const ANTHROPIC = ['anthropic-models-md', 'anthropic-pricing-md']

async function poll(ids: readonly string[], f: SourceFetcher, at: string) {
  return runRefresh({ db, raw, fetcher: f, sourcesYaml, now: clockAt(at) }, 'survey', ids)
}

// ── The launch, as a rewrite of the committed pages ─────────────────────────

const OPUS_5_PRICE_ROW = /^\| Claude Opus 5 +\|.*$/m
const OPUS_5_BATCH_ROW = /^\| Claude Opus 5 +\| \$2\.50 \/ MTok.*\n/m

const pricing = fixtureText('fixtures/pricing/anthropic-pricing.md')
/** The pricing page with a Claude Opus 5.5 row listed beside Opus 5, at Opus 5's prices. */
const pricingLaunched = () => {
  const row = pricing.match(OPUS_5_PRICE_ROW)![0]
  return pricing.replace(row, `${row}\n${row.replace('Claude Opus 5 ', 'Claude Opus 5.5')}`)
}
/** The pricing page without Opus 5's batch row, so restoring it is a new tier of a known model. */
const pricingWithoutOpus5Batch = () => pricing.replace(OPUS_5_BATCH_ROW, '')

const models = fixtureText('fixtures/pricing/anthropic-models-overview.md')
const START_WITH = 'start with [Claude Opus 5]'
/** The models page after the vendor re-points "start with" at Opus 5.5. */
const modelsRepointed = () => {
  expect(models).toContain(START_WITH)
  return models.replace(START_WITH, 'start with [Claude Opus 5.5]')
}

const alerts = () => db.select().from(schema.alerts)
const ops = () => db.select().from(schema.opsEvents)
const runs = () => db.select().from(schema.sourceRuns)

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
    schema.alerts,
    schema.changes,
    schema.entities,
    schema.snapshots,
    schema.opsEvents,
  ]) {
    await db.delete(table)
  }
})

describe('model-floor', () => {
  it('alerts a model no catalog listed before, once, with no judge in the loop', async () => {
    await poll(ANTHROPIC, fetcher(), '2026-09-22T12:00:00Z')
    expect(await alerts()).toHaveLength(0)

    const launched = fetcher({ 'anthropic-pricing-md': pricingLaunched() })
    const report = await poll(ANTHROPIC, launched, '2026-09-22T18:00:00Z')
    expect(report.sources.find((s) => s.source_id === 'anthropic-pricing-md')).toMatchObject({
      status: 'ok',
      alerts: 1,
    })

    const [alert, ...rest] = await alerts()
    expect(rest).toHaveLength(0)
    expect(alert).toMatchObject({
      rule: 'model-floor',
      severity: 'notable',
      headline: 'Anthropic lists a new model, claude-opus-5-5 — $5.00 in / $25.00 out per MTok',
      source_url: idToUrl.get('anthropic-pricing-md'),
    })
    const cited = JSON.parse(alert!.change_ids) as string[]
    const changes = await db.select().from(schema.changes)
    expect(cited).toEqual(
      changes
        .filter((c) => c.entity_key.startsWith('model:anthropic:claude-opus-5-5'))
        .map((c) => c.id),
    )

    // The models page naming it later is not a second launch.
    await poll(
      ANTHROPIC,
      fetcher({
        'anthropic-pricing-md': pricingLaunched(),
        'anthropic-models-md': modelsRepointed(),
      }),
      '2026-09-22T18:30:00Z',
    )
    expect(await alerts()).toHaveLength(1)
  })

  it('stays silent on a new tier of a model the same page already listed', async () => {
    await poll(
      ['anthropic-pricing-md'],
      fetcher({ 'anthropic-pricing-md': pricingWithoutOpus5Batch() }),
      '2026-09-22T12:00:00Z',
    )
    const report = await poll(['anthropic-pricing-md'], fetcher(), '2026-09-22T18:00:00Z')
    expect(report.sources[0]).toMatchObject({ status: 'ok', added: 1, alerts: 0 })
    expect(await alerts()).toHaveLength(0)
  })
})

describe('launch watch', () => {
  async function launchDay() {
    await poll(ANTHROPIC, fetcher(), '2026-09-22T12:00:00Z')
    await poll(
      ANTHROPIC,
      fetcher({
        'anthropic-pricing-md': pricingLaunched(),
        'anthropic-models-md': modelsRepointed(),
      }),
      '2026-09-22T18:00:00Z',
    )
  }

  it('reports a cell still showing the old flagship after an hour, then every six', async () => {
    await launchDay()
    const kv = memoryKv()

    // Refresh's own flip event, and nothing from the watch inside the hour.
    const flip = await ops()
    expect(flip.map((e) => e.kind)).toEqual(['class_basis_stale'])
    expect(
      (await checkLaunchCoverage(db, kv, new Date('2026-09-22T18:45:00Z'))).stale_cells,
    ).toEqual([])

    const later = await checkLaunchCoverage(db, kv, new Date('2026-09-22T19:30:00Z'))
    expect(later.stale_cells).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        class: 'flagship',
        model_slug: 'claude-opus-5',
      }),
    ])
    const still = (await ops()).filter((e) => e.kind === 'class_basis_still_stale')
    expect(still).toHaveLength(1)
    expect(still[0]!.detail).toContain('anthropic flagship still shows claude-opus-5')

    // The marker holds it to one line until it expires.
    await checkLaunchCoverage(db, kv, new Date('2026-09-22T20:00:00Z'))
    expect((await ops()).filter((e) => e.kind === 'class_basis_still_stale')).toHaveLength(1)
    kv.keys.clear()
    await checkLaunchCoverage(db, kv, new Date('2026-09-23T01:30:00Z'))
    expect((await ops()).filter((e) => e.kind === 'class_basis_still_stale')).toHaveLength(2)
  })

  it('reports a new model no alert cites, and never a baseline one', async () => {
    await launchDay()
    const at = new Date('2026-09-22T21:00:00Z')
    // The floor alerted it, and every baseline slug arrived with no change.
    expect((await launchCoverage(db, at)).unalerted).toEqual([])

    await db.delete(schema.alerts)
    const kv = memoryKv()
    const coverage = await checkLaunchCoverage(db, kv, at)
    expect(coverage.unalerted.map((m) => m.model_slug)).toEqual(['claude-opus-5-5'])
    await checkLaunchCoverage(db, kv, new Date('2026-09-22T21:30:00Z'))
    expect((await ops()).filter((e) => e.kind === 'launch_unalerted')).toHaveLength(1)

    // Inside two hours of the listing the judge still has a run to make.
    expect((await launchCoverage(db, new Date('2026-09-22T19:00:00Z'))).unalerted).toEqual([])
  })

  it('puts both counts on /api/fleet', async () => {
    await launchDay()
    await db.delete(schema.alerts)
    const counters = await collectFleetCounters(db, new Date('2026-09-22T21:00:00Z'))
    expect(counters.extra).toMatchObject({ launchStaleCells: 1, launchUnalerted: 1 })
  })
})

describe('tripwire', () => {
  const TRIPWIRE_BASE = [
    'anthropic-models-md',
    'openai-models-md',
    'xai-models-md',
    'google-pricing-html',
  ]

  it('yields on the half-hour ticks the other polls own', () => {
    expect(isPollInstant(new Date('2026-09-22T18:00:03Z'))).toBe(true)
    expect(isPollInstant(new Date('2026-09-22T18:30:02Z'))).toBe(true)
    expect(isPollInstant(new Date('2026-09-22T18:05:02Z'))).toBe(false)
    expect(isPollInstant(new Date('2026-09-22T18:25:02Z'))).toBe(false)
  })

  it('writes nothing while the catalogs match the store', async () => {
    await poll(TRIPWIRE_BASE, fetcher(), '2026-09-22T12:00:00Z')
    const before = {
      runs: (await runs()).length,
      snapshots: (await db.select().from(schema.snapshots)).length,
    }

    const f = fetcher()
    const outcome = await runTripwire({
      db,
      raw,
      fetcher: f,
      sourcesYaml,
      lock: memoryKv(),
      now: clockAt('2026-09-22T12:05:00Z'),
    })
    expect(outcome).toEqual({ status: 'quiet', checked: TRIPWIRE_BASE })
    expect(f.calls).toEqual(TRIPWIRE_BASE)
    expect((await runs()).length).toBe(before.runs)
    expect((await db.select().from(schema.snapshots)).length).toBe(before.snapshots)
  })

  it('polls the catalogs off-cycle when one changes, then cools that source down', async () => {
    await poll(
      [...TRIPWIRE_BASE, 'anthropic-pricing-md', 'openai-pricing-md'],
      fetcher(),
      '2026-09-22T12:00:00Z',
    )

    const kv = memoryKv()
    const launched = fetcher({
      'anthropic-models-md': modelsRepointed(),
      'anthropic-pricing-md': pricingLaunched(),
    })
    const outcome = await runTripwire({
      db,
      raw,
      fetcher: launched,
      sourcesYaml,
      lock: kv,
      now: clockAt('2026-09-22T18:05:00Z'),
    })
    expect(outcome).toMatchObject({ status: 'tripped', by: ['anthropic-models-md'] })
    const tripwireRuns = (await runs()).filter((r) => r.scope === 'tripwire')
    expect(tripwireRuns.map((r) => r.source_id).sort()).toEqual(
      [...TRIPWIRE_BASE, 'anthropic-pricing-md', 'openai-pricing-md'].sort(),
    )
    expect((await alerts()).map((a) => a.rule)).toEqual(['model-floor'])

    // Five minutes on, the Anthropic page is cooling down and the rest match.
    const next = await runTripwire({
      db,
      raw,
      fetcher: launched,
      sourcesYaml,
      lock: kv,
      now: clockAt('2026-09-22T18:10:00Z'),
    })
    expect(next).toEqual({
      status: 'quiet',
      checked: TRIPWIRE_BASE,
    })
    expect(kv.keys.has('tripwire:cooldown:anthropic-models-md')).toBe(true)
  })

  it('leaves a held poll lock alone and checks again next tick', async () => {
    await poll(TRIPWIRE_BASE, fetcher(), '2026-09-22T12:00:00Z')
    const kv = memoryKv()
    kv.keys.set('poll:lock', 'survey@2026-09-22T18:00:00Z')
    const outcome = await runTripwire({
      db,
      raw,
      fetcher: fetcher({ 'anthropic-models-md': modelsRepointed() }),
      sourcesYaml,
      lock: kv,
      now: clockAt('2026-09-22T18:05:00Z'),
    })
    expect(outcome).toMatchObject({ status: 'tripped', skipped: 'survey@2026-09-22T18:00:00Z' })
    expect(kv.keys.has('tripwire:cooldown:anthropic-models-md')).toBe(false)
  })
})
