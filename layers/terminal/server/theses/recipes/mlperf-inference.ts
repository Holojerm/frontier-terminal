// MLPerf Inference, datacenter suite: the published token throughput of each
// submitted system, from each round's results repository and its own summary
// file (Apache 2.0). It is the only public, reviewed measure of tokens per
// second on named hardware, and the reason an implied utilization is a pair
// of bounds: the same accelerator serves a 405B model about 100 times slower
// than an 8B one.
//
// Kept: closed division, systems marked available, the Server scenario, and
// results in tokens per second. One observation per result. `value` is our
// division of the system's result by its accelerator count. MLCommons does
// not review that figure, so every surface that shows it says so and cites
// the result ID (MLPerf Results Messaging Guidelines; docs/source-audit.md,
// 2026-11-19).
//
// A round is published once and dated by MLCommons's announcement, so each
// row's date is its round's. A run reads the oldest listed round newer than
// the newest stored, so the rounds arrive one per run, oldest first, and the
// runs after that re-read the newest round alone (a correction to it still
// lands). A new round is a new line in MLPERF_ROUNDS, added by hand with its
// fixture. A round older than the newest stored is never read: adding one
// means clearing this recipe's rows, as migration 0060 did.

import type { Observation, Recipe } from './contract'

export interface MlperfRound {
  round: string
  /** The day MLCommons announced the round's results. */
  published: string
}

/**
 * Oldest first. v5.0 and earlier are left out: v5.0's repository states no
 * license, and v4.1 and earlier publish no summary file (docs/source-audit.md,
 * 2026-11-20).
 */
export const MLPERF_ROUNDS: readonly MlperfRound[] = [
  { round: 'v5.1', published: '2025-09-09' },
  { round: 'v6.0', published: '2026-04-01' },
]

export const mlperfRepo = (round: string) =>
  `https://github.com/mlcommons/inference_results_${round}`
export const mlperfUrl = (round: string) =>
  `https://raw.githubusercontent.com/mlcommons/inference_results_${round}/main/summary_results.json`

/** The round a run reads: the oldest one newer than the newest stored, else the newest. */
export function nextMlperfRound(newest: string | null): MlperfRound {
  return MLPERF_ROUNDS.find((r) => newest === null || r.published > newest) ?? MLPERF_ROUNDS.at(-1)!
}

/**
 * What MLCommons requires beside any use of a result it has not verified in
 * this form: suite, round, division and scenario, where and when the results
 * were retrieved, the unverified statement and the trademark legend. The
 * result IDs are printed on each row.
 */
export const mlperfFootnote = (round: string, retrieved: string): string =>
  `MLPerf® Inference ${round}, Datacenter, Closed division, Server scenario. Retrieved from ${mlperfRepo(round)} on ${retrieved}. Tokens per second per accelerator is our division of each result by its accelerator count. Result not verified by MLCommons Association. The MLPerf name and logo are registered and unregistered trademarks of MLCommons Association in the United States and other countries. All rights reserved. Unauthorized use strictly prohibited. See www.mlcommons.org for more information.`

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
  Nodes?: number
  'a#'?: number | string
  /** From v6.0; earlier summaries give nodes and accelerators per node. */
  'Total Accelerators'?: number
  Performance_Result?: number
  Performance_Units?: string
  version?: string
}

/** v6.0 states the total, and it is nodes times accelerators per node on every result. */
const acceleratorsOf = (r: Result): number =>
  r['Total Accelerators'] ?? (Number(r.Nodes) || 0) * (Number(r['a#']) || 0)

export function extractMlperf(body: string): Observation[] {
  const doc = JSON.parse(body) as unknown
  if (!Array.isArray(doc) || !(doc as Result[]).some((r) => r.Suite === 'datacenter')) {
    throw new Error('not an MLPerf Inference summary')
  }
  const round = MLPERF_ROUNDS.find((r) => r.round === (doc as Result[])[0]?.version)
  if (!round) throw new Error(`round ${(doc as Result[])[0]?.version} is not listed`)
  const obs: Observation[] = []
  for (const r of doc as Result[]) {
    if (r.version !== round.round) throw new Error(`${r.ID}: round ${r.version} in ${round.round}`)
    if (r.Suite !== 'datacenter' || r.Category !== 'closed' || r.Availability !== 'available') {
      continue
    }
    if (r.Scenario !== 'Server' || r.Performance_Units !== 'Tokens/s') continue
    const n = acceleratorsOf(r)
    // A CPU-only system has no accelerator to divide by.
    if (!n) continue
    if (!r.ID || !r.Model || !r.Accelerator || !(Number(r.Performance_Result) > 0)) {
      throw new Error(`MLPerf result ${r.ID ?? '(no ID)'} is missing a field`)
    }
    obs.push({
      key: `${r.ID}|${r.Model}`,
      date: round.published,
      value: r.Performance_Result! / n,
      payload: {
        result_id: r.ID,
        round: round.round,
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
  description: `MLPerf Inference datacenter results, rounds ${MLPERF_ROUNDS.map((r) => r.round).join(' and ')}: tokens per second per system and accelerator count (closed division, Server scenario)`,
  url: ({ newest }) => mlperfUrl(nextMlperfRound(newest).round),
  ext: 'json',
  extract: (body) => extractMlperf(body),
  license: `Apache License 2.0 (${MLPERF_ROUNDS.map((r) => `mlcommons/inference_results_${r.round}`).join(', ')}). MLPerf Results Messaging Guidelines apply to every use.`,
}
