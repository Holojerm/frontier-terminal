import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import azure from '~~/fixtures/recipes/gpu-azure.json?raw'
import coreweave from '~~/fixtures/recipes/gpu-coreweave.html?raw'
import crusoe from '~~/fixtures/recipes/gpu-crusoe.html?raw'
import digitalocean from '~~/fixtures/recipes/gpu-digitalocean.html?raw'
import lambda from '~~/fixtures/recipes/gpu-lambda.html?raw'
import nebius from '~~/fixtures/recipes/gpu-nebius.html?raw'
import oracle from '~~/fixtures/recipes/gpu-oracle.json?raw'
import together from '~~/fixtures/recipes/gpu-together.html?raw'
import verda from '~~/fixtures/recipes/gpu-verda.html?raw'
import crwv from '~~/fixtures/recipes/sec-companyfacts-crwv.json?raw'
import type { ClaimDef } from '../shared/utils/thesis-types'

import * as schema from '~~/server/db/schema'
import { insertRows } from '../server/pipeline/store'
import { crusoeRows } from '../server/theses/recipes/gpu-pages'
import type { SourceFetcher } from '../server/pipeline/fetch'
import {
  blendedPrice,
  gpuMedian,
  labSetChange,
  median,
  sumAcrossLabs,
  type GpuObservation,
} from '../server/theses/compute-signals'
import { COMPUTE_THESIS } from '../server/theses/compute'
import { evaluateTheses } from '../server/theses/evaluate'
import type { Recipe } from '../server/theses/recipes/contract'
import { gpuOf, gpuPriceObservation } from '../server/theses/recipes/gpu-prices'
import { GPU_RECIPES, RECIPES } from '../server/theses/recipes/registry'
import { runRecipes } from '../server/theses/recipes/run'
import { evaluateClaim, type StoredReading } from '../server/theses/status'
import { queryContext, queryCoverage } from '../server/utils/terminal-db'
import { queryGpuPrices } from '../server/utils/terminal-gpu'
import { daysBefore } from '../server/utils/terminal-rankings'
import { queryTheses } from '../server/utils/terminal-theses'
import { fixtureText } from './pipeline/fixtures'

// The Compute thesis: the GPU price recipes against pages captured
// 2026-11-02 (fixtures/manifest.json), the equal-weight medians, the
// sustained-drawdown rule, and one evaluation over a seeded D1 that checks
// every claim's first reading.

const FIXTURES: Record<string, string> = {
  'gpu-lambda': lambda,
  'gpu-coreweave': coreweave,
  'gpu-nebius': nebius,
  'gpu-crusoe': crusoe,
  'gpu-together': together,
  'gpu-digitalocean': digitalocean,
  'gpu-verda': verda,
  'gpu-azure': azure,
  'gpu-oracle': oracle,
  'sec-revenue-crwv': crwv,
}
const DATE = '2026-11-02'
const extract = (r: Recipe) => r.extract(FIXTURES[r.id]!, { date: DATE })
const recipe = (id: string) => RECIPES.find((r) => r.id === id)!
const counted = (id: string, gpu: string) =>
  extract(recipe(id))
    .filter((o) => o.payload.gpu === gpu && o.payload.counted)
    .map((o) => o.value)

describe('labSetChange', () => {
  const price = { model_slug: 'm', input_per_mtok: 1, output_per_mtok: 1, blended: 1 }
  const state = (labs: string[]) => ({
    flagships: Object.fromEntries(
      labs.map((l) => [l, { ...price, basis_current: true, source_url: 'u', fetched_at: 't' }]),
    ),
  })
  it('flags a lab joining or leaving the median, which no price move explains', () => {
    expect(labSetChange({ openai: {}, xai: {} }, state(['openai', 'mistral']))).toEqual({
      added: ['mistral'],
      removed: ['xai'],
    })
  })
  it('is null for the same set, and for a first reading', () => {
    expect(labSetChange({ openai: {}, xai: {} }, state(['xai', 'openai']))).toBeNull()
    expect(labSetChange(null, state(['openai']))).toBeNull()
  })
})

describe('GPU price recipes', () => {
  // From 2026-11-03 Crusoe prints today's price beside a scheduled one
  // ("New on-demand starting Dec 1, 2026"); before, beside spot.
  it('Crusoe: reads the current on-demand column under either header, and no other', () => {
    const h100 = (html: string) =>
      crusoeRows(html)
        .filter((r) => r.gpu === 'H100')
        .map((r) => r.usd_per_gpu_hour)
    expect(h100(crusoe)).toEqual([3.9]) // not the $4.50 it moves to on Dec 1
    const scheduled =
      '<div class="pricing-heading is-d">Current on-demand</div><div><div class="pricing-heading is-d">New on-demand</div><div class="pricing_up">starting Dec 1, 2026</div></div>'
    const spot =
      '<div class="pricing-heading is-d">On-demand</div><div class="pricing-heading is-d">Current spot</div>'
    expect(crusoe).toContain(scheduled)
    expect(h100(crusoe.replace(scheduled, spot))).toEqual([3.9])
    expect(() => crusoeRows(crusoe.replace('>Current on-demand<', '>Reserved<'))).toThrow(
      'GPU instances header reads',
    )
  })

  it('reads each provider’s on-demand H100 and B200 prices per GPU-hour', () => {
    expect(counted('gpu-lambda', 'H100').sort()).toEqual([3.99, 4.09, 4.19, 4.29])
    expect(counted('gpu-lambda', 'B200').sort()).toEqual([6.69, 6.79, 6.89, 6.99])
    expect(counted('gpu-coreweave', 'H100')).toEqual([6.155])
    expect(counted('gpu-coreweave', 'B200')).toEqual([8.6])
    expect(counted('gpu-nebius', 'H100')).toEqual([4.5])
    expect(counted('gpu-nebius', 'B200')).toEqual([8.5])
    expect(counted('gpu-crusoe', 'H100')).toEqual([3.9])
    expect(counted('gpu-crusoe', 'B200')).toEqual([])
    expect(counted('gpu-together', 'H100')).toEqual([3.99])
    expect(counted('gpu-together', 'B200')).toEqual([8.19])
    expect(counted('gpu-digitalocean', 'H100')).toEqual([4.41])
    expect(counted('gpu-verda', 'H100')).toEqual([4.793, 4.793])
    expect(counted('gpu-verda', 'B200')).toEqual([8.869])
    expect(counted('gpu-oracle', 'H100')).toEqual([10])
    expect(counted('gpu-oracle', 'B200')).toEqual([14])
  })

  it('keeps instance prices beside the per-GPU price, and divides by the GPUs per instance', () => {
    const [h100] = extract(recipe('gpu-coreweave')).filter((o) => o.payload.gpu === 'H100')
    expect(h100!.payload).toMatchObject({
      label: 'NVIDIA HGX H100',
      gpus_per_instance: 8,
      instance_usd_per_hour: 49.24,
    })
    const nd = extract(recipe('gpu-azure')).find(
      (o) => o.payload.label === 'Standard_ND96isr_H100_v5' && o.payload.region === 'eastus',
    )!
    expect(nd.value).toBe(12.29)
    expect(nd.payload).toMatchObject({ form_factor: 'SXM', gpus_per_instance: 8, counted: true })
  })

  it('records PCIe and NVL cards without counting them', () => {
    const lambdaPcie = extract(recipe('gpu-lambda')).find((o) => o.payload.form_factor === 'PCIe')!
    expect(lambdaPcie).toMatchObject({ value: 3.29, payload: { counted: false } })
    const nc = extract(recipe('gpu-azure')).filter((o) => o.payload.label.startsWith('Standard_NC'))
    expect(nc.length).toBeGreaterThan(0)
    expect(nc.every((o) => o.payload.form_factor === 'NVL' && !o.payload.counted)).toBe(true)
  })

  it('skips the products that are not on-demand compute', () => {
    // Together's dedicated endpoints ($5.49), Crusoe's self-serve deployments
    // ($5.50), Verda's serverless containers ($5.27) and Lambda's 1-Click
    // Clusters ($6.16) are all on these pages; none is read.
    expect(counted('gpu-together', 'H100')).not.toContain(5.49)
    expect(counted('gpu-crusoe', 'H100')).not.toContain(5.5)
    expect(counted('gpu-verda', 'H100')).not.toContain(5.27)
    expect(counted('gpu-lambda', 'H100')).not.toContain(6.16)
    // Oracle's AI Enterprise licence is priced per GPU-hour but is software.
    expect(extract(recipe('gpu-oracle')).map((o) => o.payload.label)).toEqual([
      'OCI - Compute - GPU - B200',
      'Oracle Cloud Infrastructure - Compute - GPU - H100',
    ])
  })

  it('gives every observation a contract-valid payload', () => {
    for (const r of GPU_RECIPES) {
      for (const o of extract(r)) expect(() => gpuPriceObservation.parse(o)).not.toThrow()
    }
  })

  it('fails a page whose pricing section is gone, rather than storing nothing', () => {
    for (const r of GPU_RECIPES) {
      const empty = r.ext === 'json' ? '{"Items":[],"items":[]}' : '<html><body></body></html>'
      expect(() => r.extract(empty, { date: DATE }), r.id).toThrow()
    }
  })

  it('names the GPU only as a whole word', () => {
    expect(gpuOf('NVIDIA GB200 NVL72')).toBeNull()
    expect(gpuOf('OCI - Compute - GPU - H100T')).toBeNull()
    expect(gpuOf('NVIDIA H100 NVL')).toEqual({ gpu: 'H100', form_factor: 'NVL' })
    expect(gpuOf('1x B200 SXM6 180GB')).toEqual({ gpu: 'B200', form_factor: 'SXM' })
  })
})

describe('compute arithmetic', () => {
  const o = (provider: string, value: number, extra: Partial<GpuObservation> = {}) => ({
    provider,
    gpu: 'H100' as const,
    counted: true,
    value,
    source_url: `https://${provider}.test`,
    fetched_at: '2026-11-02T00:00:00Z',
    ...extra,
  })

  it('blends three input tokens to one output token', () => {
    expect(blendedPrice(5, 25, 3, 1)).toBe(10)
  })

  it('counts each provider once, at the median of its own rows', () => {
    const m = gpuMedian('H100', [
      o('azure', 12),
      o('azure', 13),
      o('azure', 14),
      o('azure', 15),
      o('azure', 16),
      o('lambda', 4),
      o('nebius', 5),
      o('nebius', 99, { counted: false }),
      o('oracle', 99, { gpu: 'B200' }),
    ])
    expect(m.providers).toMatchObject({ azure: { value: 14, rows: 5 }, lambda: { value: 4 } })
    expect(Object.keys(m.providers)).toEqual(['azure', 'lambda', 'nebius'])
    expect(m.median).toBe(5)
    expect(median([])).toBeNull()
  })

  it('sums a cluster across labs, and a lab joins the sum from its first day', () => {
    const prov = { source_url: 'u', fetched_at: 'f' }
    const sums = sumAcrossLabs([
      {
        lab: 'xai',
        dates: ['2026-10-01', '2026-10-02', '2026-10-03'],
        series: [10, 11, 12],
        ...prov,
      },
      { lab: 'mistral', dates: ['2026-10-03'], series: [5], ...prov },
    ])
    expect(sums.map((s) => [s.date, s.value])).toEqual([
      ['2026-10-01', 10],
      ['2026-10-02', 11],
      ['2026-10-03', 17],
    ])
    expect(sums[2]!.by_lab).toEqual({ xai: 12, mistral: 5 })
  })
})

describe('sustained drawdown', () => {
  const claim: ClaimDef = {
    ...COMPUTE_THESIS.claims[1]!,
    spec: {
      kind: 'measured',
      signal: 'flagship-blended-price',
      input_weight: 3,
      output_weight: 1,
      rule: { rule: 'sustained-drawdown', drop: 0.3, days: 28, weeks: 4 },
    },
  }
  const fmt = (v: number) => v.toFixed(2)
  const series = (days: number, at: (d: number) => number, newest = '2026-12-31') =>
    Array.from({ length: days + 1 }, (_, i): StoredReading => {
      const back = days - i
      return { date: daysBefore(newest, back), value: at(back), compare: null }
    })

  it('is unresolved until every checkpoint has its full window, and says how much there is', () => {
    const e = evaluateClaim(
      claim,
      series(30, () => 10),
      fmt,
    )
    expect(e.status).toBe('unresolved')
    expect(e.reason).toMatch(/30 of 49 days of history, needs 49/)
  })

  it('holds at the high, and weakens past half the drop', () => {
    expect(
      evaluateClaim(
        claim,
        series(60, () => 10),
        fmt,
      ).status,
    ).toBe('holding')
    const dip = evaluateClaim(
      claim,
      series(60, (back) => (back === 0 ? 8 : 10)),
      fmt,
    )
    expect(dip.status).toBe('weakening')
  })

  it('breaks only after 4 straight weekly checkpoints at or past the drop', () => {
    // Fell to 6 (40% off a high of 10) 15 days ago: three checkpoints past it.
    const three = series(80, (back) => (back <= 15 ? 6 : 10))
    expect(evaluateClaim(claim, three, fmt)).toMatchObject({ status: 'weakening' })
    expect(evaluateClaim(claim, three, fmt).reason).toMatch(/at 3 of 4 straight/)
    const four = series(80, (back) => (back <= 22 ? 6 : 10))
    expect(evaluateClaim(claim, four, fmt).status).toBe('broken')
  })

  it('is unresolved on a reading the signal marked void, and skips older void readings', () => {
    const base = series(60, () => 10)
    const voidNow = [...base.slice(0, -1), { ...base.at(-1)!, value: 1, void_reason: '4 of 5' }]
    expect(evaluateClaim(claim, voidNow, fmt)).toMatchObject({
      status: 'unresolved',
      reason: '4 of 5',
    })
    const voidBefore = base.map((r, i) => (i === 20 ? { ...r, value: 1, void_reason: 'x' } : r))
    expect(evaluateClaim(claim, voidBefore, fmt).status).toBe('holding')
  })
})

// ---- one evaluation over a seeded store --------------------------------------

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const NOW = new Date('2026-11-02T12:00:00Z')
const NEWEST_RANKING = '2026-11-01'
const RANKINGS_URL = 'https://openrouter.ai/api/v1/datasets/rankings-daily'
const BOARD_URL = 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs'

const entity = (
  source_id: string,
  entity_key: string,
  entity_type: string,
  provider: string,
  payload: Record<string, unknown>,
  source_url: string,
) => ({
  source_id,
  entity_key,
  entity_type,
  provider,
  content_hash: entity_key,
  payload: JSON.stringify(payload),
  snapshot_id: `snap-${source_id}`,
  first_seen_at: '2026-08-25T00:00:00Z',
  source_url,
  fetched_at: '2026-11-02T06:00:00Z',
})

// The class map's flagship slugs, priced so the blends are 11.25, 10, 4.5, 6 and 2.
const FLAGSHIPS = [
  ['openai', 'openai-pricing-md', 'gpt-6-astra', 5, 30],
  ['anthropic', 'anthropic-pricing-md', 'claude-opus-5-5', 5, 25],
  ['google', 'google-pricing-html', 'gemini-4-argon', 2, 12],
  ['xai', 'xai-models-md', 'grok-4.7', 3, 15],
  ['meta', 'meta-pricing-md', 'muse-wonder-1.0', 1.25, 4.25],
] as const

// Per day: the tracked labs 600 of 1,000 tokens, everyone else 400.
const DAILY_TOKENS = {
  'openai/gpt-6-astra': 250,
  'anthropic/claude-opus-5-5': 150,
  'google/gemini-4-argon': 120,
  'x-ai/grok-4.7': 50,
  'meta/muse-wonder-1.0': 20,
  'mistralai/mistral-large-4': 10,
  'z-ai/glm-5.3': 300,
  other: 100,
} as const
const PROVIDER_OF: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  'x-ai': 'xai',
  meta: 'meta',
  mistralai: 'mistral',
}

const fetcher: SourceFetcher = async (source) => {
  const text = FIXTURES[source.source_id]
  return text
    ? { ok: true, status: 200, text, bytes: text.length }
    : { ok: false, status: 404, detail: 'HTTP 404' }
}
const raw = { put: async (key: string, body: string) => void (await env.BLOB.put(key, body)) }

// 30s, not the 10s default: seeding row by row and running every recipe took
// 7.6s in Workers Builds on a fast run and timed out on a slow one.
beforeAll(async () => {
  const rows = []
  for (const [provider, source_id, slug, input, output] of FLAGSHIPS) {
    rows.push(
      entity(
        source_id,
        `model:${provider}:${slug}`,
        'model',
        provider,
        { model_slug: slug, tier: null, input_per_mtok: input, output_per_mtok: output },
        `https://${source_id}.test`,
      ),
    )
  }
  for (let d = 119; d >= 0; d--) {
    const date = daysBefore(NEWEST_RANKING, d)
    for (const [slug, tokens] of Object.entries(DAILY_TOKENS)) {
      rows.push(
        entity(
          'openrouter-rankings-daily',
          `ranking:${date}:${slug}`,
          'ranking',
          PROVIDER_OF[slug.split('/')[0]!] ?? 'other',
          { date, model_permaslug: slug, total_tokens: tokens * 1_000_000 },
          RANKINGS_URL,
        ),
      )
    }
  }
  const jobs = [
    ...Array.from({ length: 7 }, (_, i) => ({ id: `d${i}`, department: 'Data Center' })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, department: 'Compute' })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, department: 'Sales' })),
  ]
  for (const j of jobs) {
    rows.push(
      entity(
        'anthropic-greenhouse',
        `job:anthropic:${j.id}`,
        'job',
        'anthropic',
        { job_id: j.id, title: 'Role', department: j.department },
        BOARD_URL,
      ),
    )
  }
  for (const row of rows) await db.insert(schema.entities).values(row)
  await insertRows(db, 'snapshots', [
    {
      id: 'snap-anthropic-greenhouse',
      source_id: 'anthropic-greenhouse',
      content_hash: 'a'.repeat(64),
      raw_key: 'raw/h',
      http_status: 200,
      bytes: 1,
      source_url: BOARD_URL,
      fetched_at: '2026-08-25T11:10:43Z',
    },
  ])
  const results = await runRecipes(
    db,
    { raw, fetcher, now: () => NOW },
    RECIPES.filter((r) => r.id in FIXTURES),
  )
  expect(results.every((r) => r.status === 'ok')).toBe(true)
}, 30_000)

const deps = { sourcesYaml, now: () => NOW }
const readingOf = async (claim_id: string) => {
  const rows = await db.select().from(schema.claimReadings)
  const own = rows.filter((r) => r.claim_id === claim_id).sort((a, b) => (a.date < b.date ? -1 : 1))
  return { all: own, newest: own.at(-1)!, detail: JSON.parse(own.at(-1)!.detail) }
}

describe('the Compute thesis on a seeded store', () => {
  it('writes every claim’s first reading, and leaves each unresolved until its window fills', async () => {
    const runs = await evaluateTheses(db, deps, [COMPUTE_THESIS])
    expect(Object.fromEntries(runs.map((r) => [r.claim_id, r.status]))).toEqual({
      'compute-token-gpu-ratio': 'unresolved',
      'compute-flagship-price': 'unresolved',
      'compute-labs-demand-share': 'holding',
      'compute-physical-buildout': 'unresolved',
      'compute-rented-demand': 'holding',
      'compute-datacenter-power': 'unresolved',
    })
  })

  it('claim 1: the flagship median over the H100 median, with B200 beside it', async () => {
    const { all, newest, detail } = await readingOf('compute-token-gpu-ratio')
    expect(all).toHaveLength(1)
    expect(newest.date).toBe(DATE)
    expect(detail.flagship_median).toBe(6)
    expect(detail.gpu_median).toBe(4.5)
    expect(newest.value).toBe(1.3333)
    expect(Object.keys(detail.gpu_providers)).toHaveLength(9)
    expect(detail.gpu_providers.lambda.value).toBe(4.14)
    expect(detail.quorum).toEqual({ have: 9, need: 5 })
    expect(detail.void_reason).toBeNull()
    expect(detail.context).toMatchObject({ gpu: 'B200', gpu_median: 8.55, ratio: 0.7018 })
    expect(Object.keys(detail.context.providers)).toHaveLength(6)
    // The three labs added 2026-11-04 are outside the set claims 1 and 2 opened on.
    expect(detail.no_flagship).toEqual({
      mistral: 'no mapped flagship',
      deepseek: 'outside the labs this claim counts',
      alibaba: 'outside the labs this claim counts',
      moonshot: 'outside the labs this claim counts',
    })
  })

  it('claim 2: the median flagship blended price, citing every flagship’s own row', async () => {
    const { newest, detail } = await readingOf('compute-flagship-price')
    expect(newest.value).toBe(6)
    expect(detail.flagships.openai).toMatchObject({ model_slug: 'gpt-6-astra', blended: 11.25 })
    expect(detail.flagships.meta.source_url).toBe('https://meta-pricing-md.test')
    expect(detail.flagship_changed).toBeNull()
    expect(detail.lab_set).toEqual(Object.keys(detail.flagships).sort())
    expect(detail.lab_set_changed).toBeNull()
  })

  it('claim 3: the tracked labs’ combined share of every token, rebuilt from the rankings', async () => {
    const { all, newest } = await readingOf('compute-labs-demand-share')
    expect(newest.value).toBe(0.6)
    expect(newest.date).toBe(NEWEST_RANKING)
    expect(all.length).toBeGreaterThan(100)
  })

  it('claim 4: physical-infrastructure roles summed over labs with a feed, naming the rest', async () => {
    const { newest, detail } = await readingOf('compute-physical-buildout')
    expect(newest.value).toBe(10)
    expect(detail.by_lab).toEqual({ anthropic: 10 })
    expect(Object.keys(detail.no_feed).sort()).toEqual([
      'alibaba',
      'deepseek',
      'google',
      'meta',
      'mistral',
      'moonshot',
      'openai',
      'xai',
    ])
  })

  it('claim 5: CoreWeave’s revenue against the same quarter a year earlier', async () => {
    const { newest, detail } = await readingOf('compute-rented-demand')
    expect(newest.date).toBe('2026-06-30')
    expect(newest.value).toBe(1.1246)
    expect(detail.base_date).toBe('2025-06-30')
  })

  it('serves the same medians on /api/gpu-prices, every row with its page and fetch', async () => {
    const data = await queryGpuPrices(
      db,
      queryContext(sourcesYaml, null, () => NOW),
    )
    const h100 = data.medians.find((m) => m.gpu === 'H100')!
    expect(h100.median).toBe(4.5)
    expect(h100.providers).toHaveLength(9)
    expect(data.medians.find((m) => m.gpu === 'B200')!.median).toBe(8.55)
    expect(data.failed).toEqual([])
    expect(data.prices.every((p) => p.source_url.startsWith('https://') && p.fetched_at)).toBe(true)
    expect(data.prices.find((p) => p.provider === 'microsoft')!.provider_name).toBe(
      'Microsoft Azure',
    )
  })

  it('lists every recipe on the coverage panel with its audit caveat and terms', async () => {
    const coverage = await queryCoverage(
      db,
      queryContext(sourcesYaml, null, () => NOW),
    )
    const ids = coverage.recipes.map((r) => r.recipe_id)
    expect(ids).toEqual(RECIPES.map((r) => r.id))
    const azureRow = coverage.recipes.find((r) => r.recipe_id === 'gpu-azure')!
    expect(azureRow.last_run?.status).toBe('ok')
    expect(azureRow.observations).toBeGreaterThan(100)
    expect(azureRow.terms).toMatch(/documents for unauthenticated price lookup/)
    expect(azureRow.newest?.fetched_at).toBe(NOW.toISOString())
    expect(coverage.recipes.every((r) => r.rights !== null)).toBe(true)
    expect(coverage.recipes.find((r) => r.recipe_id === 'npm-wrangler')!.rights).toBe('upstream')
    expect(coverage.cuts.map((c) => c.id)).toContain('gpu-runpod')
  })

  it('marks a reading void when fewer than 5 H100 providers had a price', async () => {
    const later = new Date('2026-11-03T12:00:00Z')
    const failing: SourceFetcher = async () => ({ ok: false, status: 500, detail: 'HTTP 500' })
    await runRecipes(db, { raw, fetcher: failing, now: () => later }, GPU_RECIPES.slice(0, 5))
    await evaluateTheses(db, { sourcesYaml, now: () => later }, [COMPUTE_THESIS])
    const { newest, detail } = await readingOf('compute-token-gpu-ratio')
    expect(newest.date).toBe('2026-11-03')
    expect(detail.quorum).toEqual({ have: 4, need: 5 })
    expect(Object.keys(detail.gpu_failed)).toHaveLength(5)

    const data = await queryTheses(
      db,
      queryContext(sourcesYaml, null, () => later),
    )
    const claim = data.theses.find((t) => t.id === 'compute')!.claims[0]!
    expect(claim.status).toBe('unresolved')
    expect(claim.reason).toBe('4 of the 5 H100 providers the median needs had a price today.')
    expect(claim.series.map((p) => p.date)).toEqual([DATE])
  })

  it('notes a change of mapped flagship on the reading it first appears in', async () => {
    const day = new Date('2026-11-04T12:00:00Z')
    await db
      .insert(schema.entities)
      .values(
        entity(
          'openai-pricing-md',
          'model:openai:gpt-6-nova',
          'model',
          'openai',
          { model_slug: 'gpt-6-nova', tier: null, input_per_mtok: 4, output_per_mtok: 20 },
          'https://openai-pricing-md.test',
        ),
      )
    await db.insert(schema.classMapDecisions).values({
      id: 'decision-1',
      provider: 'openai',
      class: 'flagship',
      model_slug: 'gpt-6-nova',
      basis: 'Start with GPT-6 Nova.',
      basis_source_id: 'openai-models-md',
      decided_at: '2026-11-04T00:00:00Z',
      decided_by: 'judge',
      source_url: 'https://openai-models-md.test',
      fetched_at: '2026-11-04T00:00:00Z',
    })
    await evaluateTheses(db, { sourcesYaml, now: () => day }, [COMPUTE_THESIS])
    const { detail } = await readingOf('compute-flagship-price')
    expect(detail.flagship_changed).toEqual({ openai: { from: 'gpt-6-astra', to: 'gpt-6-nova' } })

    const data = await queryTheses(
      db,
      queryContext(sourcesYaml, null, () => day),
    )
    const series = data.theses.find((t) => t.id === 'compute')!.claims[1]!.series
    expect(series.at(-1)!.note).toBe('Flagship changed: OpenAI gpt-6-astra → gpt-6-nova')
    expect(series[0]!.note).toBeUndefined()
  })
})
