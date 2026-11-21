import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import chipTypes from '~~/fixtures/recipes/epoch-chip-types.csv?raw'
import chipUsers from '~~/fixtures/recipes/epoch-chip-users.csv?raw'
import epochSites from '~~/fixtures/recipes/epoch-data-centers.csv?raw'
import azure from '~~/fixtures/recipes/gpu-azure.json?raw'
import coreweave from '~~/fixtures/recipes/gpu-coreweave.html?raw'
import mlperf51 from '~~/fixtures/recipes/mlperf-inference-datacenter-v5.1.json?raw'
import mlperf from '~~/fixtures/recipes/mlperf-inference-datacenter-v6.0.json?raw'
import crwvFacts from '~~/fixtures/recipes/sec-companyfacts-crwv.json?raw'
import crwvRelease from '~~/fixtures/recipes/sec-crwv-active-power.html?raw'
import googlRelease from '~~/fixtures/recipes/sec-googl-api-tokens.html?raw'
import * as schema from '~~/server/db/schema'
import type { SourceFetcher } from '#layers/core/server/pipeline/fetch'
import type { Recipe } from '#layers/core/server/recipes/contract'
import {
  SEC_CRWV_ACTIVE_POWER,
  SEC_GOOGL_API_TOKENS,
  extractActivePower,
  extractApiTokens,
  releaseUrl,
} from '../server/recipes/earnings-releases'
import {
  EPOCH_CHIP_TYPES,
  EPOCH_CHIP_USERS,
  extractChipTypes,
  extractChipUsers,
} from '../server/recipes/epoch-chip-users'
import { EPOCH_DATA_CENTERS } from '../server/recipes/epoch-data-centers'
import { GPU_AZURE } from '../server/recipes/gpu-apis'
import { GPU_COREWEAVE } from '../server/recipes/gpu-pages'
import { gpuObservations, gpuPricePayload } from '../server/recipes/gpu-prices'
import {
  MLPERF_INFERENCE,
  MLPERF_ROUNDS,
  extractMlperf,
  mlperfFootnote,
  mlperfRoundsFootnote,
  mlperfUrl,
  nextMlperfRound,
} from '../server/recipes/mlperf-inference'
import { runRecipes } from '#layers/terminal/server/theses/recipes/run'
import { SEC_REVENUE_CRWV } from '#layers/terminal/server/theses/recipes/sec-revenue'
import { queryContext } from '#layers/core/server/utils/terminal-db'
import {
  SPOT_QUORUM,
  coreweaveQuarters,
  h100eOf,
  impliedRows,
  listPriceFloor,
  mlperfChip,
  roundRows,
  spotRead,
  type RoundResult,
} from '../server/utils/terminal-utilization'
import {
  demandShape,
  queryUtilization,
} from '#layers/terminal/server/utils/terminal-utilization-query'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// The utilization read: the recipes it adds against fixtures fetched
// 2026-11-20 (fixtures/manifest.json), the bounds arithmetic on its own, and
// the whole payload over a store the recipe runner filled. Golden values are
// the sources' own; sentences are quoted from the releases on EDGAR.

const release = (title: string, body: string) =>
  `<html><body><p>EX-99.1 Document ${title}</p><ul><li>• ${body}</li></ul></body></html>`

// ── The releases' own words ─────────────────────────────────────────────────

const QUARTER_ENDS: Record<string, string> = {
  'Q1 2025': '2025-03-31',
  'Q2 2025': '2025-06-30',
  'Q3 2025': '2025-09-30',
  'Q4 2025': '2025-12-31',
  'Q1 2026': '2026-03-31',
  'Q2 2026': '2026-06-30',
  'Q3 2026': '2026-09-30',
}

/** Quarter, MW, qualifier, release title, and the sentence as CoreWeave printed it. */
function POWER_SENTENCES(): [string, number, string | null, string, string][] {
  return [
    [
      'Q1 2025',
      420,
      'approximately',
      'CoreWeave Reports Strong First Quarter 2025 Results',
      'Continued rapid scaling of our purpose-built AI Infrastructure, including the addition of new compute capacity which totaled approximately 420 MW of active power and approximately 1.6 GW of contracted power at quarter end',
    ],
    [
      'Q2 2025',
      470,
      'approximately',
      'CoreWeave Reports Strong Second Quarter 2025 Results',
      'We ended the quarter with approximately 470 MW of active power and we increased total contracted power approximately 600 MW to 2.2 GW',
    ],
    [
      'Q3 2025',
      590,
      'approximately',
      'CoreWeave Reports Strong Third Quarter 2025 Results',
      'Added approximately 120 MW of active power in the quarter, bringing the total to approximately 590 MW',
    ],
    [
      'Q4 2025',
      850,
      'more than',
      'CoreWeave Reports Strong Fourth Quarter and Fiscal Year 2025 Results',
      'Added approximately 260 MW of active power capacity, bringing the total to more than 850 MW',
    ],
    [
      'Q1 2026',
      1000,
      'surpassed',
      'CoreWeave Reports Strong First Quarter 2026 Results',
      'Surpassed 1 GW of active power',
    ],
    [
      'Q2 2026',
      1500,
      null,
      'CoreWeave Reports Strong Second Quarter 2026 Results',
      'Expanded active power by nearly 500 MWs to reach 1.5 GW',
    ],
    [
      'Q3 2026',
      1700,
      'over',
      'CoreWeave Reports Strong Third Quarter 2026 Results',
      'Added more than 200 MWs of active power to reach over 1.7 GW, doubling our active footprint since the start of the year',
    ],
  ]
}

const hit = (id: string, filed: string, items: string[]) => ({
  _id: id,
  _source: { file_date: filed, file_type: 'EX-99.1', items },
})

/** EDGAR full-text search for "tokens per minute" in Alphabet's 8-Ks, as answered 2026-11-20, relevance order. */
const GOOGL_SEARCH = JSON.stringify({
  hits: {
    hits: [
      hit('0001193125-26-257724:d83560dex991.htm', '2026-06-04', ['1.01', '7.01', '8.01', '9.01']),
      hit('0001652044-26-000043:googexhibit991q12026.htm', '2026-04-29', ['2.02', '9.01']),
      hit('0001652044-26-000012:googexhibit991q42025.htm', '2026-02-04', ['2.02', '9.01']),
      hit('0001652044-26-000066:googexhibit991q22026.htm', '2026-07-22', ['2.02', '9.01']),
      hit('0001652044-25-000087:googexhibit991q32025.htm', '2025-10-29', ['2.02', '9.01']),
      hit('0001652044-26-000080:googexhibit991q32026.htm', '2026-10-28', ['2.02', '9.01']),
    ],
  },
})

/** The same search with only the release the fixture holds. */
function GOOGL_SEARCH_NEWEST(): string {
  return JSON.stringify({
    hits: {
      hits: [hit('0001652044-26-000080:googexhibit991q32026.htm', '2026-10-28', ['2.02', '9.01'])],
    },
  })
}

describe('earnings releases', () => {
  it('reads Alphabet’s tokens per minute, its qualifier and the sentence', () => {
    expect(extractApiTokens(googlRelease)).toEqual([
      {
        key: 'api_tokens_per_minute',
        date: '2026-09-30',
        value: 32_000_000_000,
        payload: {
          quarter: 'Q3 2026',
          released: '2026-10-28',
          qualifier: 'nearly',
          sentence:
            'Overall, our first-party model APIs are now processing nearly 32 billion tokens per minute, more than four times what we processed a year ago.',
        },
      },
    ])
  })

  it.each([
    [
      'Alphabet Announces Third Quarter 2025 Results',
      'In addition to topping leaderboards, our first party models, like Gemini, now process 7 billion tokens per minute, via direct API use by our customers.',
      '2025-09-30',
      7e9,
      null,
    ],
    [
      'Alphabet Announces Fourth Quarter and Fiscal Year 2025 Results',
      'Our first party models, like Gemini, now process over 10 billion tokens per minute via direct API use by our customers, and the Gemini App has grown to over 750 million monthly active users.',
      '2025-12-31',
      10e9,
      'over',
    ],
    [
      'Alphabet Announces First Quarter 2026 Results',
      'Our first-party models, like Gemini, are now processing more than 16 billion tokens per minute via direct API use by our customers, up 60% from last quarter.',
      '2026-03-31',
      16e9,
      'more than',
    ],
    [
      'Alphabet Announces Second Quarter 2026 Results',
      'Gemini models now process 22 billion API tokens per minute and the Gemini App has 950 million monthly active users.',
      '2026-06-30',
      22e9,
      null,
    ],
  ])('reads each earlier wording: %s', (title, sentence, date, value, qualifier) => {
    const [o] = extractApiTokens(release(title, sentence))
    expect(o).toMatchObject({ date, value, payload: { qualifier } })
  })

  it('reads CoreWeave’s active power from a release', () => {
    expect(extractActivePower(crwvRelease)).toEqual([
      {
        key: 'active_power_mw',
        date: '2026-06-30',
        value: 1500,
        payload: {
          quarter: 'Q2 2026',
          released: '2026-08-11',
          qualifier: null,
          sentence: 'Expanded active power by nearly 500 MWs to reach 1.5 GW',
        },
      },
    ])
  })

  it.each(POWER_SENTENCES())('reads %s as %d MW', (quarter, mw, qualifier, title, sentence) => {
    const [o] = extractActivePower(release(title, sentence))
    expect(o).toMatchObject({ value: mw, payload: { quarter, qualifier } })
  })

  it('skips guidance that uses the same words about a later date', () => {
    const [o] = extractActivePower(
      release(
        'CoreWeave Reports Strong First Quarter 2026 Results',
        'We surpassed 1 GW of active power and believe we are well on our way to more than 8 GW by 2030. • Surpassed 1 GW of active power',
      ),
    )
    expect(o!.payload.sentence).toBe('Surpassed 1 GW of active power')
  })

  it('fails on a release with no such sentence, or no quarter in its title', () => {
    expect(() =>
      extractActivePower(release('CoreWeave Reports Third Quarter 2026 Results', 'Revenue grew.')),
    ).toThrow(/active power/)
    expect(() => extractApiTokens(release('Alphabet Announces Results', 'x'))).toThrow(/quarter/)
    expect(() => extractApiTokens('{"error":"not found"}')).toThrow(/HTML/)
  })

  it('walks the releases one per run: the oldest first, then the one after the newest stored quarter', () => {
    const cik = '0001652044'
    const at = (name: string) => expect.stringContaining(name)
    expect(releaseUrl(GOOGL_SEARCH, cik, null)).toBe(
      'https://www.sec.gov/Archives/edgar/data/1652044/000165204425000087/googexhibit991q32025.htm',
    )
    expect(releaseUrl(GOOGL_SEARCH, cik, '2025-09-30')).toEqual(at('googexhibit991q42025.htm'))
    expect(releaseUrl(GOOGL_SEARCH, cik, '2026-06-30')).toEqual(at('googexhibit991q32026.htm'))
    // Nothing newer: the stored quarter's own release again, which the runner records as unchanged.
    expect(releaseUrl(GOOGL_SEARCH, cik, '2026-09-30')).toEqual(at('googexhibit991q32026.htm'))
  })

  it('reads only earnings releases: an 8-K that is not Item 2.02 is left out', () => {
    expect(releaseUrl(GOOGL_SEARCH, '0001652044', '2026-03-31')).not.toContain('d83560dex991')
    expect(() => releaseUrl('{"hits":{"hits":[]}}', '0001652044', null)).toThrow(/no earnings/)
    expect(() => releaseUrl('{}', '0001652044', null)).toThrow(/search answer/)
  })
})

describe('MLPerf Inference', () => {
  const obs = extractMlperf(mlperf)

  it('keeps closed, available, Server results in tokens per second, divided by the accelerator count', () => {
    expect(obs).toHaveLength(150)
    expect(obs[0]).toEqual({
      key: '6.0-0001|llama2-70b-99',
      date: '2026-04-01',
      value: 1_016_380 / 88,
      payload: {
        result_id: '6.0-0001',
        round: 'v6.0',
        model: 'llama2-70b-99',
        scenario: 'Server',
        submitter: 'AMD',
        system: 'AMD MI355X Custom Cluster',
        accelerator: 'AMD Instinct MI355X 288GB HBM3e (x87)',
        accelerators: 88,
        tokens_per_second: 1_016_380,
      },
    })
    expect(new Set(obs.map((o) => o.payload.scenario))).toEqual(new Set(['Server']))
  })

  it('reads v5.1, which states nodes and accelerators per node instead of a total', () => {
    const v51 = extractMlperf(mlperf51)
    // 155 results, less the six CPU-only systems.
    expect(v51).toHaveLength(149)
    expect(new Set(v51.map((o) => o.date))).toEqual(new Set(['2025-09-09']))
    expect(new Set(v51.map((o) => o.payload.round))).toEqual(new Set(['v5.1']))
    expect(v51[0]).toEqual({
      key: '5.1-0001|llama2-70b-99',
      date: '2025-09-09',
      value: 24_593.8 / 8,
      payload: {
        result_id: '5.1-0001',
        round: 'v5.1',
        model: 'llama2-70b-99',
        scenario: 'Server',
        submitter: 'AMD',
        system: 'Supermicro AS-8125GS-TNMR2',
        accelerator: 'AMD Instinct MI300X 192GB HBM3',
        accelerators: 8,
        tokens_per_second: 24_593.8,
      },
    })
    // A mixed cluster: 6 nodes of 8, the 32 MI300X and 16 MI325X its accelerator string lists.
    expect(v51.find((o) => o.key === '5.1-0065|llama2-70b-99')!.payload.accelerators).toBe(48)
    // Result IDs carry the round, so no key is shared with v6.0.
    const keys = new Set(obs.map((o) => o.key))
    expect(v51.filter((o) => keys.has(o.key))).toEqual([])
  })

  it('reads the rounds oldest first, one per run, then stays on the newest', () => {
    expect(MLPERF_ROUNDS.map((r) => r.round)).toEqual(['v5.1', 'v6.0'])
    expect(nextMlperfRound(null).round).toBe('v5.1')
    expect(nextMlperfRound('2025-09-09').round).toBe('v6.0')
    expect(nextMlperfRound('2026-04-01').round).toBe('v6.0')
    expect(MLPERF_INFERENCE.url({ now: NOW, newest: null })).toBe(
      'https://raw.githubusercontent.com/mlcommons/inference_results_v5.1/main/summary_results.json',
    )
  })

  it('fails on an unlisted round, a mixed body, or a body that is not the summary', () => {
    expect(() =>
      extractMlperf(mlperf.replaceAll('"version": "v6.0"', '"version": "v6.1"')),
    ).toThrow(/round v6.1 is not listed/)
    expect(() => extractMlperf(mlperf.replace('"version": "v6.0"', '"version": "v5.1"'))).toThrow(
      /round v6.0 in v5.1/,
    )
    expect(() => extractMlperf('[]')).toThrow(/not an MLPerf/)
  })

  it('carries the footnote MLCommons requires, with the round and the unverified statement', () => {
    const footnote = mlperfFootnote('v5.1', '2026-11-20')
    expect(footnote).toContain(
      'MLPerf® Inference v5.1, Datacenter, Closed division, Server scenario. Retrieved from https://github.com/mlcommons/inference_results_v5.1 on 2026-11-20.',
    )
    expect(footnote).toContain('Result not verified by MLCommons Association.')
    expect(footnote).toContain(
      'The MLPerf name and logo are registered and unregistered trademarks of MLCommons Association in the United States and other countries. All rights reserved. Unauthorized use strictly prohibited. See www.mlcommons.org for more information.',
    )
  })
})

describe('MLPerf rounds footnote', () => {
  it('names every round compared, its retrieval, the basis of the change and the unverified statement', () => {
    const footnote = mlperfRoundsFootnote([
      { round: 'v5.1', retrieved: '2026-11-20' },
      { round: 'v6.0', retrieved: '2026-11-21' },
    ])
    expect(footnote).toContain(
      'MLPerf® Inference v5.1 and v6.0, Datacenter, Closed division, Server scenario. Retrieved from https://github.com/mlcommons/inference_results_v5.1 on 2026-11-20 and https://github.com/mlcommons/inference_results_v6.0 on 2026-11-21.',
    )
    expect(footnote).toContain('the change between rounds is our comparison')
    expect(footnote).toContain('MLPerf Compatibility Table')
    expect(footnote).toContain('Result not verified by MLCommons Association.')
    expect(footnote).toContain('See www.mlcommons.org for more information.')
  })
})

describe('Epoch AI chip data', () => {
  it('reads Google’s running fleet with its percentiles', () => {
    const fleet = extractChipUsers(chipUsers).find(
      (o) => o.key === 'Google DeepMind|operational' && o.date === '2025-12-31',
    )!
    expect(fleet.value).toBeCloseTo(3_424_014.42, 1)
    expect(fleet.payload).toMatchObject({ label: 'Operational fleet', units: 'H100e' })
    expect(fleet.payload.p5).toBeCloseTo(2_616_947.11, 1)
    expect(fleet.payload.p95).toBeCloseTo(4_549_369.57, 1)
  })

  it('rates chip types in H100-equivalents and matches them to benchmark accelerators', () => {
    const types = extractChipTypes(chipTypes, { date: '2026-11-20' })
    const ratings = new Map(types.flatMap((o) => (o.value === null ? [] : [[o.key, o.value]])))
    expect(ratings.get('H100')).toBe(1)
    expect(h100eOf('NVIDIA H200-NVL-141GB', ratings)).toBe(1)
    expect(h100eOf('NVIDIA B200-SXM-180GB', ratings)).toBeCloseTo(2.5265, 4)
    // A GB300 rack is counted by its B300 GPUs.
    expect(h100eOf('NVIDIA GB300', ratings)).toBe(ratings.get('B300'))
    expect(h100eOf('Intel(R) Arc Pro(R) B60', ratings)).toBeNull()
  })

  it('fails on a renamed column', () => {
    expect(() => extractChipUsers(chipUsers.replace('value_med', 'median'))).toThrow(/value_med/)
  })
})

describe('GPU spot prices', () => {
  it('keeps CoreWeave’s spot price beside the on-demand row, both when the page prints two', () => {
    const h100 = GPU_COREWEAVE.extract(coreweave, { date: '2026-11-02' }).find(
      (o) => o.payload.gpu === 'H100',
    )!
    expect(h100.value).toBe(6.155)
    expect(gpuPricePayload.parse(h100.payload)).toMatchObject({
      instance_usd_per_hour: 49.24,
      // $19.51 and $19.71 an hour for 8 GPUs.
      spot_low_usd_per_gpu_hour: 2.4388,
      spot_high_usd_per_gpu_hour: 2.4638,
    })
  })

  it('pairs each Azure pay-as-you-go row with its region’s Spot meter', () => {
    const row = GPU_AZURE.extract(azure, { date: '2026-11-02' }).find(
      (o) => o.payload.label === 'Standard_ND96isr_H100_v5' && o.payload.region === 'eastus',
    )!
    expect(row.value).toBe(12.29)
    expect(row.payload.spot_low_usd_per_gpu_hour).toBe(2.2712)
    expect(row.payload.spot_high_usd_per_gpu_hour).toBe(2.2712)
  })

  it('reads a row stored before spot prices were kept', () => {
    const {
      spot_low_usd_per_gpu_hour: _low,
      spot_high_usd_per_gpu_hour: _high,
      ...old
    } = gpuObservations(
      'lambda',
      [
        {
          gpu: 'H100',
          form_factor: 'SXM',
          label: '8x H100',
          usd_per_gpu_hour: 3.99,
          gpus_per_instance: 8,
          instance_usd_per_hour: null,
          region: null,
          config: null,
        },
      ],
      '2026-11-02',
    )[0]!.payload
    expect(gpuPricePayload.parse(old)).toMatchObject({
      spot_low_usd_per_gpu_hour: null,
      spot_high_usd_per_gpu_hour: null,
    })
  })
})

const prov = { source_url: 'https://example.test/pricing', fetched_at: '2026-11-20T00:00:00Z' }

describe('spotRead', () => {
  const row = (provider: string, value: number, spot: number | null) => ({
    provider,
    gpu: 'H100' as const,
    counted: true,
    value,
    spot_low: spot,
    spot_high: spot,
    ...prov,
  })

  it('prints no combined figure below the quorum', () => {
    const read = spotRead([row('coreweave', 5, 2), row('microsoft', 10, 2), row('lambda', 4, null)])
    expect(read.providers.map((p) => [p.provider, p.ratio.low])).toEqual([
      ['coreweave', 0.4],
      ['microsoft', 0.2],
    ])
    expect(read.combined.find((c) => c.gpu === 'H100')).toEqual({
      gpu: 'H100',
      providers: 2,
      ratio: null,
    })
  })

  it('takes the median across providers once the quorum is met, each provider counted once', () => {
    const read = spotRead([
      row('coreweave', 10, 4),
      row('microsoft', 10, 2),
      row('microsoft', 10, 2),
      row('microsoft', 10, 2),
      row('crusoe', 10, 6),
      row('nebius', 10, 8),
    ])
    expect(SPOT_QUORUM).toBe(4)
    expect(read.combined.find((c) => c.gpu === 'H100')).toEqual({
      gpu: 'H100',
      providers: 4,
      ratio: { low: 0.5, high: 0.5 },
    })
  })

  it('leaves out rows the median does not count', () => {
    expect(spotRead([{ ...row('microsoft', 10, 6), counted: false }]).providers).toEqual([])
  })
})

describe('impliedRows', () => {
  const ratings = new Map([
    ['H100', 1],
    ['B200', 2.5],
  ])
  const result = (id: string, model: string, accelerator: string, per: number) => ({
    result_id: id,
    model,
    accelerator,
    per_accelerator: per,
  })

  it('bounds the load by the fastest and slowest result, against the fleet’s 95th and 5th percentiles', () => {
    const { models, unrated_results } = impliedRows(
      6_000_000,
      { p5: 100, p95: 400 },
      [
        result('a', 'small', 'NVIDIA H100-SXM-80GB', 1000),
        result('b', 'small', 'NVIDIA B200-SXM-180GB', 5000),
        result('c', 'large', 'NVIDIA H100-SXM-80GB', 100),
        result('d', 'small', 'Some CPU', 1),
      ],
      ratings,
    )
    // 6M tokens a minute is 100,000 a second. Small: 1,000 and 2,000 per H100e.
    expect(models.find((m) => m.model === 'small')).toMatchObject({
      results: 2,
      slowest: { per_h100e: 1000, result_id: 'a' },
      fastest: { per_h100e: 2000, result_id: 'b' },
      h100e_busy: { low: 50, high: 100 },
      share: { low: 0.125, high: 1 },
    })
    expect(models.find((m) => m.model === 'large')!.share).toEqual({ low: 2.5, high: 10 })
    expect(unrated_results).toBe(1)
  })
})

describe('mlperfChip', () => {
  it('names one chip per system, without the system’s count or the submitter’s tag', () => {
    expect(mlperfChip('AMD Instinct MI355X 288GB HBM3e (x87)')).toEqual({
      key: 'amd instinct mi355x 288gb hbm3e',
      label: 'AMD Instinct MI355X 288GB HBM3e',
    })
    expect(mlperfChip('[MAXSUN] MS-Intel Arc Pro B60 Dual 48G Turbo')!.label).toBe(
      'MS-Intel Arc Pro B60 Dual 48G Turbo',
    )
    // A power cap is a different configuration, so it stays its own chip.
    expect(mlperfChip('AMD Instinct MI355X 288GB HBM3e (Power Cap 1000 W)')!.label).toBe(
      'AMD Instinct MI355X 288GB HBM3e (Power Cap 1000 W)',
    )
  })

  it('names no chip for a system that mixes them', () => {
    expect(
      mlperfChip('AMD Instinct MI300X 192GB HBM3 (x32), AMD Instinct MI325X 256GB HBM3e (x16)'),
    ).toBeNull()
    expect(
      mlperfChip(
        'AMD Instinct MI300X 192GB HBM3 (x8) and AMD Instinct MI325X 256GB HBM3e (x8) and AMD Instinct MI355X 288GB HBM3e (x8)',
      ),
    ).toBeNull()
  })
})

describe('roundRows', () => {
  const result = (
    round: string,
    result_id: string,
    per_accelerator: number,
    over: Partial<RoundResult> = {},
  ): RoundResult => ({
    round,
    result_id,
    model: 'llama3.1-8b',
    accelerator: 'NVIDIA B200-SXM-180GB',
    accelerators: 8,
    submitter: 'NVIDIA',
    system: 'DGX B200',
    per_accelerator,
    ...over,
  })

  it('keeps each round’s fastest result and the change from the round before', () => {
    const { rows } = roundRows(
      [result('v5.1', '5.1-1', 1000), result('v5.1', '5.1-2', 1200), result('v6.0', '6.0-1', 1500)],
      ['v5.1', 'v6.0'],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.results.map((r) => r!.result_id)).toEqual(['5.1-2', '6.0-1'])
    expect(rows[0]!.change).toBeCloseTo(0.25, 9)
  })

  it('compares only at the same accelerator count, and counts the chip left out', () => {
    const out = roundRows(
      [result('v5.1', '5.1-1', 1000), result('v6.0', '6.0-1', 900, { accelerators: 72 })],
      ['v5.1', 'v6.0'],
    )
    expect(out.rows).toEqual([])
    expect(out.accelerators_left_out).toBe(1)
  })

  it('keeps the SXM and NVL versions of a chip apart, and leaves mixed systems out', () => {
    const out = roundRows(
      [
        result('v5.1', '5.1-1', 1000, { accelerator: 'NVIDIA H200-SXM-141GB' }),
        result('v6.0', '6.0-1', 900, { accelerator: 'NVIDIA H200-NVL-141GB' }),
        result('v6.0', '6.0-2', 900, { accelerator: 'A (x4), B (x4)' }),
      ],
      ['v5.1', 'v6.0'],
    )
    expect(out).toEqual({ rows: [], accelerators_left_out: 2, mixed_results: 1 })
  })

  it('with three rounds, leaves a gap where one is missing and compares the newest two present', () => {
    const { rows } = roundRows(
      [result('a', 'a-1', 1000), result('c', 'c-1', 3000)],
      ['a', 'b', 'c'],
    )
    expect(rows[0]!.results.map((r) => r?.result_id ?? null)).toEqual(['a-1', null, 'c-1'])
    expect(rows[0]!.change).toBeCloseTo(2, 9)
  })
})

describe('coreweaveQuarters', () => {
  const power = POWER_SENTENCES().map(([quarter, active_mw, qualifier]) => ({
    quarter,
    period_end: QUARTER_ENDS[quarter]!,
    active_mw,
    qualifier,
  }))

  it('divides revenue by the average of active power at the quarter’s start and end', () => {
    const quarters = coreweaveQuarters(
      new Map([
        ['2026-06-30', 2_575e6],
        ['2026-09-30', 3_661e6],
      ]),
      power,
    )
    expect(quarters.map((q) => q.quarter)).toEqual(['Q2 2026', 'Q3 2026'])
    // $3,661M over (1,500 + 1,700) / 2 MW.
    expect(quarters[1]!.revenue_per_mw).toBeCloseTo(2_288_125, 0)
  })

  it('has no figure for a quarter with no earlier power to average with', () => {
    expect(coreweaveQuarters(new Map([['2025-03-31', 982e6]]), power)[0]).toMatchObject({
      active_mw: 420,
      revenue_per_mw: null,
    })
  })

  it('puts a quarter’s revenue against the same power at list price', () => {
    // 1,600 MW × 1,000 H100e × 2,208 hours in Q3 = 3.5328 billion H100e-hours.
    const share = listPriceFloor(
      { period_end: '2026-09-30', revenue_usd: 3_661e6, avg_active_mw: 1600 },
      1000,
      [6.155, 3.4],
    )!
    expect(share.low).toBeCloseTo(3_661e6 / (3.5328e9 * 6.155), 6)
    expect(share.high).toBeCloseTo(3_661e6 / (3.5328e9 * 3.4), 6)
    expect(
      listPriceFloor({ period_end: '2026-09-30', revenue_usd: 1, avg_active_mw: 1 }, 1000, []),
    ).toBeNull()
  })
})

describe('demandShape', () => {
  it('is the average day over the busiest day', () => {
    const rows = Array.from({ length: 7 }, (_, i) => [
      { date: `2026-11-0${i + 1}`, total_tokens: i === 2 ? 150 : 50 },
      { date: `2026-11-0${i + 1}`, total_tokens: 50 },
    ]).flat()
    expect(demandShape(rows)).toEqual({
      window: { from: '2026-11-01', to: '2026-11-07' },
      days: 7,
      mean_tokens: 800 / 7,
      peak_tokens: 200,
      peak_date: '2026-11-03',
      ratio: 800 / 7 / 200,
    })
  })

  it('needs a week of days', () => {
    expect(demandShape([{ date: '2026-11-01', total_tokens: 1 }])).toBeNull()
  })
})

// ── The payload, over a store the runner filled ─────────────────────────────

const db = drizzle(env.DB, { schema })
const NOW = new Date('2026-11-20T06:00:00Z')
const raw = { put: async (key: string, body: string) => void (await env.BLOB.put(key, body)) }
const ok = (body: string) => ({ ok: true as const, status: 200, text: body, bytes: body.length })

/** The stated history, through the real extractors, without committing every release. */
const stated = (
  recipe: Recipe,
  extract: (html: string) => ReturnType<Recipe['extract']>,
): Recipe => ({
  ...recipe,
  url: () => `test://${recipe.id}`,
  follow: undefined,
  extract,
})

const BODIES: Record<string, string> = {
  'https://www.coreweave.com/pricing': coreweave,
  [GPU_AZURE.url({ now: NOW, newest: null })]: azure,
  [mlperfUrl('v5.1')]: mlperf51,
  [mlperfUrl('v6.0')]: mlperf,
  'https://epoch.ai/data/ai_chip_users_intermediates_by_lab.csv': chipUsers,
  'https://epoch.ai/data/ai_chip_sales_chip_types.csv': chipTypes,
  'https://epoch.ai/data/data_centers/data_centers.csv': epochSites,
  [SEC_REVENUE_CRWV.url({ now: NOW, newest: null })]: crwvFacts,
  [SEC_GOOGL_API_TOKENS.url({ now: NOW, newest: null })]: GOOGL_SEARCH_NEWEST(),
  'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000080/googexhibit991q32026.htm':
    googlRelease,
  'test://sec-crwv-active-power': 'history',
}
const fetcher: SourceFetcher = async (s) =>
  BODIES[s.url] ? ok(BODIES[s.url]!) : { ok: false, status: 404, detail: `HTTP 404 ${s.url}` }

describe('queryUtilization', () => {
  beforeAll(async () => {
    const results = await runRecipes(db, { raw, fetcher, now: () => NOW }, [
      GPU_COREWEAVE,
      GPU_AZURE,
      MLPERF_INFERENCE,
      EPOCH_CHIP_USERS,
      EPOCH_CHIP_TYPES,
      EPOCH_DATA_CENTERS,
      SEC_REVENUE_CRWV,
      SEC_GOOGL_API_TOKENS,
      stated(SEC_CRWV_ACTIVE_POWER, () =>
        POWER_SENTENCES().flatMap(([, , , title, sentence]) =>
          extractActivePower(release(title, sentence)),
        ),
      ),
    ])
    expect(results.filter((r) => r.status !== 'ok')).toEqual([])
    // The first run read v5.1; the next reads v6.0, and the one after has nothing new.
    const later = []
    for (let i = 0; i < 2; i++)
      later.push(...(await runRecipes(db, { raw, fetcher, now: () => NOW }, [MLPERF_INFERENCE])))
    expect(later.map((r) => r.status)).toEqual(['ok', 'unchanged'])
  })

  const query = () =>
    queryUtilization(
      db,
      queryContext(fixtureText('sources.yaml'), null, () => NOW),
    )

  it('shows each provider’s spot price against its own on-demand price, and no combined figure yet', async () => {
    const { spot } = await query()
    const h100 = spot.providers.filter((p) => p.gpu === 'H100')
    expect(h100.map((p) => p.provider)).toEqual(['coreweave', 'microsoft'])
    expect(h100[0]).toMatchObject({
      provider_name: 'CoreWeave',
      on_demand: 6.155,
      spot: { low: 2.4388, high: 2.4638 },
      rows: 1,
      source_url: 'https://www.coreweave.com/pricing',
    })
    expect(h100[0]!.ratio.low).toBeCloseTo(0.3962, 4)
    expect(h100[0]!.ratio.high).toBeCloseTo(0.4003, 4)
    // Azure's 8-GPU H100 sizes: Spot at the same share of pay-as-you-go in every region.
    expect(h100[1]!.ratio.low).toBeCloseTo(0.1848, 4)
    expect(h100[1]!.ratio.high).toBeCloseTo(0.1848, 4)
    expect(spot.providers_needed).toBe(4)
    expect(spot.combined.find((c) => c.gpu === 'H100')).toEqual({
      gpu: 'H100',
      providers: 2,
      ratio: null,
    })
  })

  it('bounds Google’s stated volume per benchmark model against Epoch’s fleet range', async () => {
    const { implied } = await query()
    expect(implied!.tokens).toMatchObject({
      quarter: 'Q3 2026',
      per_minute: 32e9,
      qualifier: 'nearly',
      source: {
        source_url:
          'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000080/googexhibit991q32026.htm',
        fetched_at: NOW.toISOString(),
      },
    })
    expect(implied!.fleet.date).toBe('2025-12-31')
    const small = implied!.models.find((m) => m.model === 'llama3.1-8b')!
    // 32 billion a minute is 533.3 million a second. Fastest: 18,508 a second on a B300 (2.5265 H100e).
    expect(small.fastest).toMatchObject({ result_id: '6.0-0006' })
    expect(small.fastest.per_h100e).toBeCloseTo(7325.61, 1)
    expect(small.h100e_busy.low).toBeCloseTo(72_804, -1)
    expect(small.share.low).toBeCloseTo(72_804 / 4_549_369.57, 4)
    const large = implied!.models.find((m) => m.model === 'llama3.1-405b')!
    expect(large.slowest).toMatchObject({ result_id: '6.0-0040' })
    expect(large.h100e_busy.high).toBeCloseTo(10_959_303, -2)
    // More H100-equivalents than the fleet's own estimate: the row reads above 100%.
    expect(large.share.low).toBeGreaterThan(1)
    expect(implied!.models.at(-1)!.model).toBe('llama3.1-405b')
    expect(implied!.unrated_results).toBeGreaterThan(0)
    expect(implied!.benchmark.round).toBe('v6.0')
    expect(implied!.benchmark.footnote).toBe(mlperfFootnote('v6.0', '2026-11-20'))
    expect(implied!.benchmark.source.source_url).toBe(mlperfUrl('v6.0'))
  })

  it('keeps each past round’s rows under their own round and source, out of the newest read', async () => {
    const rows = await db
      .select()
      .from(schema.recipeObservations)
      .where(eq(schema.recipeObservations.recipe_id, MLPERF_INFERENCE.id))
    expect([...new Set(rows.map((r) => r.date))].sort()).toEqual(['2025-09-09', '2026-04-01'])
    const v51 = rows.filter((r) => r.date === '2025-09-09')
    expect(v51).toHaveLength(149)
    expect(new Set(v51.map((r) => r.source_url))).toEqual(new Set([mlperfUrl('v5.1')]))
    expect(new Set(v51.map((r) => JSON.parse(r.payload).round))).toEqual(new Set(['v5.1']))
    const { implied } = await query()
    const ids = implied!.models.flatMap((m) => [m.slowest.result_id, m.fastest.result_id])
    expect(ids.filter((id) => !id.startsWith('6.0-'))).toEqual([])
  })

  it('reads CoreWeave’s revenue per megawatt for quarters with a filed revenue and a stated power', async () => {
    const { coreweave: cw } = await query()
    const q2 = cw!.quarters.find((q) => q.quarter === 'Q2 2026')!
    expect(q2).toMatchObject({ revenue_usd: 2_575e6, active_mw: 1500, qualifier: null })
    // $2,575M over (1,000 + 1,500) / 2 MW.
    expect(q2.revenue_per_mw).toBeCloseTo(2_060_000, 0)
    expect(cw!.floor!.quarter).toBe(cw!.quarters.at(-1)!.quarter)
    expect(cw!.floor!.share.low).toBeLessThan(cw!.floor!.share.high)
    expect(cw!.floor!.share.high).toBeLessThan(1)
    // CoreWeave's own list: $6.155 for an H100, $8.60 for a B200 rated 2.5265 H100e.
    expect(cw!.floor!.list_usd_per_h100e_hour.high).toBe(6.155)
    expect(cw!.floor!.list_usd_per_h100e_hour.low).toBeCloseTo(8.6 / 2.5265, 3)
  })

  it('sets v5.1 beside v6.0 per chip, benchmark and accelerator count, with both rounds cited', async () => {
    const { benchmark_rounds: br } = await query()
    expect(br!.rounds).toEqual(['v5.1', 'v6.0'])
    expect(br!.rows).toHaveLength(24)
    expect(new Set(br!.rows.map((r) => r.accelerator)).size).toBe(8)
    // 19 chips across the two rounds, 8 of them with a like-for-like pair.
    expect(br!.accelerators_left_out).toBe(11)
    // Four v5.1 results and two v6.0 results come from clusters mixing AMD chips.
    expect(br!.mixed_results).toBe(6)
    for (const r of br!.rows) expect(r.results.every((x) => x !== null)).toBe(true)
    // One NVL72 rack in each round: the rack-scale reading stays a rack-scale reading.
    const rack = br!.rows.find(
      (r) => r.accelerator === 'NVIDIA GB200' && r.model === 'deepseek-r1',
    )!
    expect(rack.accelerators).toBe(72)
    expect(rack.change).toBeCloseTo(
      rack.results[1]!.per_accelerator / rack.results[0]!.per_accelerator - 1,
      9,
    )
    expect(br!.footnote).toBe(
      mlperfRoundsFootnote([
        { round: 'v5.1', retrieved: '2026-11-20' },
        { round: 'v6.0', retrieved: '2026-11-20' },
      ]),
    )
    expect(br!.sources.map((s) => s.source_url)).toEqual([mlperfUrl('v5.1'), mlperfUrl('v6.0')])
  })

  it('never pairs results whose node layout differs, on either stored round', async () => {
    // The rule keys on the accelerator count. Check it against the layout each summary states.
    const layout = new Map<string, string>()
    for (const body of [mlperf51, mlperf]) {
      for (const r of JSON.parse(body) as { ID: string; Nodes: number; 'a#': number | string }[]) {
        layout.set(r.ID, `${r.Nodes}x${r['a#']}`)
      }
    }
    const { benchmark_rounds: br } = await query()
    for (const r of br!.rows) {
      const shapes = new Set(r.results.map((x) => layout.get(x!.result_id)))
      expect(shapes.size, `${r.accelerator} ${r.model}`).toBe(1)
    }
  })

  it('has no demand shape without rankings rows, and says nothing in its place', async () => {
    expect((await query()).demand_shape).toBeNull()
  })
})
