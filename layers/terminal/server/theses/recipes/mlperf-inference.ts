// MLPerf Inference, datacenter suite: the published token throughput of each
// submitted system, from the results repository's own summary file (Apache
// 2.0). It is the only public, reviewed measure of tokens per second on named
// hardware, and the reason an implied utilization is a pair of bounds: the
// same accelerator serves a 405B model about 100 times slower than an 8B one.
//
// Kept: closed division, systems marked available, the Server scenario, and
// results in tokens per second. One observation per result. `value` is our
// division of the system's result by its accelerator count. MLCommons does
// not review that figure, so every surface that shows it says so and cites
// the result ID (MLPerf Results Messaging Guidelines; docs/source-audit.md,
// 2026-11-19).
//
// The round is in the URL. A new round is a new URL, changed here by hand
// with its fixture, so a round never replaces another unseen.

import type { Observation, Recipe } from './contract'

export const MLPERF_ROUND = 'v6.0'

/**
 * What MLCommons requires beside any use of a result it has not verified in
 * this form: suite, round, division and scenario, where and when the results
 * were retrieved, the unverified statement and the trademark legend. The
 * result IDs are printed on each row.
 */
export const mlperfFootnote = (retrieved: string): string =>
  `MLPerf® Inference ${MLPERF_ROUND}, Datacenter, Closed division, Server scenario. Retrieved from https://github.com/mlcommons/inference_results_${MLPERF_ROUND} on ${retrieved}. Tokens per second per accelerator is our division of each result by its accelerator count. Result not verified by MLCommons Association. The MLPerf name and logo are registered and unregistered trademarks of MLCommons Association in the United States and other countries. All rights reserved. Unauthorized use strictly prohibited. See www.mlcommons.org for more information.`

interface Result {
  ID?: string
  Submitter?: string
  Availability?: string
  Category?: string
  Suite?: string
  System?: string
  Model?: string
  Scenario?: string
  Accelerator?: string
  'Total Accelerators'?: number
  Performance_Result?: number
  Performance_Units?: string
  version?: string
}

export function extractMlperf(body: string, ctx: { date: string }): Observation[] {
  const doc = JSON.parse(body) as unknown
  if (!Array.isArray(doc) || !(doc as Result[]).some((r) => r.Suite === 'datacenter')) {
    throw new Error('not an MLPerf Inference summary')
  }
  const obs: Observation[] = []
  for (const r of doc as Result[]) {
    if (r.Suite !== 'datacenter' || r.Category !== 'closed' || r.Availability !== 'available') {
      continue
    }
    if (r.Scenario !== 'Server' || r.Performance_Units !== 'Tokens/s') continue
    if (r.version !== MLPERF_ROUND) throw new Error(`${r.ID}: round ${r.version}`)
    const n = r['Total Accelerators']
    // A CPU-only system has no accelerator to divide by.
    if (!n) continue
    if (!r.ID || !r.Model || !r.Accelerator || !(Number(r.Performance_Result) > 0)) {
      throw new Error(`MLPerf result ${r.ID ?? '(no ID)'} is missing a field`)
    }
    obs.push({
      key: `${r.ID}|${r.Model}`,
      date: ctx.date,
      value: r.Performance_Result! / n,
      payload: {
        result_id: r.ID,
        round: MLPERF_ROUND,
        model: r.Model,
        scenario: r.Scenario,
        submitter: r.Submitter ?? null,
        system: r.System ?? null,
        accelerator: r.Accelerator,
        accelerators: n,
        tokens_per_second: r.Performance_Result,
      },
    })
  }
  if (obs.length === 0) throw new Error('no datacenter Server result in tokens per second')
  return obs
}

export const MLPERF_INFERENCE: Recipe = {
  id: 'mlperf-inference-datacenter',
  company: 'frontier-labs',
  description:
    'MLPerf Inference v6.0 datacenter results: tokens per second per system and accelerator count (closed division, Server scenario)',
  url: () =>
    'https://raw.githubusercontent.com/mlcommons/inference_results_v6.0/main/summary_results.json',
  ext: 'json',
  extract: extractMlperf,
  license:
    'Apache License 2.0 (mlcommons/inference_results_v6.0). MLPerf Results Messaging Guidelines apply to every use.',
}
