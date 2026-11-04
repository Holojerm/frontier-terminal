// Thesis 3, transcribed from docs/theses/compute.md — that page is the
// journal of record; this is its machine-readable half. The kill conditions
// were registered before any reading existed: a threshold changed here is a
// thesis revision, written in the page's Revisions table in the same commit.

import type { ThesisDef } from '../../shared/utils/thesis-types'

/** Three input tokens to one output token: the blend every price claim here uses. */
const BLEND = { input_weight: 3, output_weight: 1 } as const

export const COMPUTE_THESIS: ThesisDef = {
  id: 'compute',
  title: 'Compute',
  company: 'frontier-labs',
  stance: 'bullish',
  statement:
    'Frontier labs keep pricing power as compute becomes a tradable commodity: token prices hold up relative to GPU rental costs, while demand and capacity buildout continue.',
  comparison_set: [
    'coreweave',
    'lambda',
    'nebius',
    'crusoe',
    'together',
    'digitalocean',
    'verda',
    'microsoft',
    'oracle',
  ],
  horizon: '2027-12-31',
  position: 'none',
  opened: '2026-11-02',
  doc_path: 'docs/theses/compute.md',
  claims: [
    {
      id: 'compute-token-gpu-ratio',
      n: 1,
      text: 'Token prices hold up against GPU costs',
      signal_label:
        'Median flagship blended token price ÷ median public H100 on-demand price per GPU-hour: a modeled price relationship, not a margin',
      kill_condition:
        'The ratio stays 30% or more below its 26-week high for 4 straight weekly readings',
      spec: {
        kind: 'measured',
        signal: 'flagship-price-to-gpu',
        ...BLEND,
        gpu: 'H100',
        context_gpu: 'B200',
        min_providers: 5,
        rule: { rule: 'sustained-drawdown', drop: 0.3, days: 182, weeks: 4 },
      },
    },
    {
      id: 'compute-flagship-price',
      n: 2,
      text: 'Flagship prices avoid a broad collapse',
      signal_label:
        'Median flagship blended token price, (3 × input + output) ÷ 4, across labs with a mapped flagship',
      kill_condition: 'It stays 30% or more below its 180-day high for 4 straight weekly readings',
      spec: {
        kind: 'measured',
        signal: 'flagship-blended-price',
        ...BLEND,
        rule: { rule: 'sustained-drawdown', drop: 0.3, days: 180, weeks: 4 },
      },
    },
    {
      id: 'compute-labs-demand-share',
      n: 3,
      text: 'Frontier labs keep their demand share',
      signal_label:
        'Combined OpenRouter token share of the six tracked labs, trailing 7 days (one aggregator’s traffic, not market share)',
      kill_condition: 'It stays 30% or more below its 90-day high for 4 straight weekly readings',
      spec: {
        kind: 'measured',
        signal: 'openrouter-labs-combined-share',
        rule: { rule: 'sustained-drawdown', drop: 0.3, days: 90, weeks: 4 },
      },
    },
    {
      id: 'compute-physical-buildout',
      n: 4,
      text: 'The physical buildout continues',
      signal_label:
        'Open physical-infrastructure roles, summed across labs with a usable hiring feed',
      kill_condition: 'The count falls 40% or more from its 90-day high',
      spec: {
        kind: 'measured',
        signal: 'cluster-roles-across-labs',
        cluster: 'physical-infrastructure',
        rule: { rule: 'drawdown-from-high', drop: 0.4, days: 90, min_days: 90 },
      },
    },
    {
      id: 'compute-rented-demand',
      n: 5,
      text: 'Rented compute demand keeps growing',
      signal_label:
        'CoreWeave quarterly revenue against the same quarter a year earlier (SEC filings)',
      kill_condition: 'Growth is below 30% for 2 straight quarters',
      spec: {
        kind: 'measured',
        signal: 'recipe-yoy-growth',
        recipe: 'sec-revenue-crwv',
        key: 'revenue',
        compare_recipes: [],
        format: 'percent',
        rule: { rule: 'below-floor-periods', floor: 0.3, periods: 2 },
      },
    },
    {
      // Added 2026-11-04: a supply number beside claim 4's hiring proxy.
      id: 'compute-datacenter-power',
      n: 6,
      text: 'Data-center power keeps coming online',
      signal_label: "Epoch AI's estimate of current power across the AI data centers it tracks",
      kill_condition: '20% or more below its 180-day high for 4 straight weeks',
      spec: {
        kind: 'measured',
        signal: 'recipe-snapshot-total',
        recipe: 'epoch-data-centers',
        format: 'megawatts',
        rule: { rule: 'sustained-drawdown', drop: 0.2, days: 180, weeks: 4 },
      },
    },
  ],
}
