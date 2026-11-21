// The Compute page's utilization reads, none of them a utilization figure: spot
// against on-demand per provider; implied load (Alphabet's stated tokens per minute
// against benchmark throughput, as a share of Epoch's Google fleet); and CoreWeave's
// revenue per megawatt. GET /api/utilization serves them
// (layers/terminal/server/utils/terminal-utilization-query.ts). Benchmarks span two
// orders of magnitude by model size, so implied load is a pair of bounds, never one
// number. Pure; layers/compute/test/terminal-utilization.test.ts drives it.

import { gpuProviderName } from '#layers/core/shared/utils/companies'
import type {
  Bounds,
  ImpliedModelRow,
  SpotProviderRow,
  UtilizationData,
} from '../../shared/utils/compute-views'

import { median, type GpuObservation } from '../recipes/gpu-series'
import { GPU_MODELS } from '../recipes/gpu-prices'

/** Providers that must print a spot price for one GPU before a combined figure is shown. */
export const SPOT_QUORUM = 4

/** The fleet the stated volume is set against: Epoch's row for all of Google's running chips. */
export const FLEET_KEY = 'Google DeepMind|operational'

export const SPOT_METHOD =
  'Spot and on-demand prices for the same instance, read from the same page at the same time, in USD per GPU-hour. ' +
  'Each provider counts once, at the median of its rows. Where a page prints two spot prices for one instance, we show both.'
export const SPOT_CAVEAT =
  'Spot capacity can be taken back at short notice, so it sells for less. When spare capacity runs short, the spot price moves toward the on-demand price. ' +
  'Each provider sets its own spot price, and some rarely change it. ' +
  `We show each provider on its own and print no combined figure until ${SPOT_QUORUM} providers publish a spot price for the same GPU.`

export const IMPLIED_METHOD =
  'Tokens per minute as Alphabet states them, divided by a benchmark’s tokens per second on one H100-equivalent. ' +
  'That gives the H100-equivalents the stated volume would keep busy if every token ran at that speed. ' +
  'The low end takes the fastest result against the top of Epoch AI’s range for Google’s running fleet. The high end takes the slowest result against the bottom of that range.'
export const IMPLIED_CAVEAT =
  'Each row assumes one model served every token, which never holds. Alphabet’s figure counts input and output tokens, and the benchmark counts output tokens only, which are slower to produce. ' +
  'Google serves on its own TPUs, and these benchmarks ran on other vendors’ accelerators. ' +
  'Epoch’s fleet estimate is for the end of the year shown, and the fleet also trains models and runs Google’s other products. ' +
  'A row above 100% is a model size Google’s average token can’t be running at.'

export const COREWEAVE_METHOD =
  'Revenue for the quarter divided by the average of active power at its start and end, both from CoreWeave’s filings. ' +
  'The floor compares the newest quarter’s revenue with what that power would bill at CoreWeave’s own on-demand list prices today, using Epoch AI’s average of H100-equivalents per megawatt across the sites it tracks.'
export const COREWEAVE_CAVEAT =
  'CoreWeave states active power in a sentence and rounds it (“over 1.7 GW”). Most of its capacity is sold on long contracts below list price. ' +
  'The gap between the floor and 100% is contract discount plus idle capacity, and filings don’t separate the two. The floor sets today’s list prices against a past quarter.'

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// ── Spot against on-demand ──────────────────────────────────────────────────

/** Pure: per provider and GPU, the spot price range against on-demand, over counted rows that print one. */
export function spotRead(
  observations: readonly GpuObservation[],
): Pick<UtilizationData['spot'], 'providers' | 'combined'> {
  const groups = new Map<string, GpuObservation[]>()
  for (const o of observations) {
    if (!o.counted || o.spot_low == null || o.spot_high == null) continue
    const at = `${o.gpu}|${o.provider}`
    groups.set(at, [...(groups.get(at) ?? []), o])
  }
  const providers: SpotProviderRow[] = [...groups.values()]
    .map((rows) => {
      const newest = rows.reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))
      return {
        provider: newest.provider,
        provider_name: gpuProviderName(newest.provider),
        gpu: newest.gpu,
        on_demand: median(rows.map((r) => r.value))!,
        spot: {
          low: median(rows.map((r) => r.spot_low!))!,
          high: median(rows.map((r) => r.spot_high!))!,
        },
        ratio: {
          low: median(rows.map((r) => r.spot_low! / r.value))!,
          high: median(rows.map((r) => r.spot_high! / r.value))!,
        },
        rows: rows.length,
        source_url: newest.source_url,
        fetched_at: newest.fetched_at,
      }
    })
    .sort((a, b) => byString(b.gpu, a.gpu) || byString(a.provider, b.provider))
  const combined = GPU_MODELS.map((gpu) => {
    const of = providers.filter((p) => p.gpu === gpu)
    return {
      gpu,
      providers: of.length,
      ratio:
        of.length >= SPOT_QUORUM
          ? {
              low: median(of.map((p) => p.ratio.low))!,
              high: median(of.map((p) => p.ratio.high))!,
            }
          : null,
    }
  })
  return { providers, combined }
}

// ── Implied load ────────────────────────────────────────────────────────────

/** A GB200 or GB300 rack is counted by its B200 or B300 GPUs, which is the chip Epoch rates. */
const SYSTEM_CHIP: Readonly<Record<string, string>> = { GB200: 'B200', GB300: 'B300' }

/** Epoch's H100-equivalents for the chip an MLPerf accelerator string names, or null when it rates none. */
export function h100eOf(accelerator: string, ratings: ReadonlyMap<string, number>): number | null {
  for (const word of accelerator.split(/[^A-Za-z0-9]+/)) {
    const chip = SYSTEM_CHIP[word] ?? word
    for (const [name, h100e] of ratings) {
      // Epoch writes "Instinct MI355X"; MLPerf writes "AMD Instinct MI355X 288GB".
      if (h100e > 0 && name.split(' ').at(-1) === chip) return h100e
    }
  }
  return null
}

export interface BenchmarkResult {
  result_id: string
  model: string
  accelerator: string
  /** Tokens per second per accelerator. */
  per_accelerator: number
}

/** Pure: per benchmark model, the H100-equivalents a token rate would keep busy, as a share of a fleet's range. */
export function impliedRows(
  tokensPerMinute: number,
  fleet: { p5: number; p95: number },
  results: readonly BenchmarkResult[],
  ratings: ReadonlyMap<string, number>,
): { models: ImpliedModelRow[]; unrated_results: number } {
  const perSecond = tokensPerMinute / 60
  const byModel = new Map<string, { per_h100e: number; result_id: string; accelerator: string }[]>()
  let unrated = 0
  for (const r of results) {
    const h100e = h100eOf(r.accelerator, ratings)
    if (h100e === null) {
      unrated += 1
      continue
    }
    byModel.set(r.model, [
      ...(byModel.get(r.model) ?? []),
      {
        per_h100e: r.per_accelerator / h100e,
        result_id: r.result_id,
        accelerator: r.accelerator,
      },
    ])
  }
  const models: ImpliedModelRow[] = [...byModel]
    .map(([model, rs]) => {
      const sorted = rs.toSorted(
        (a, b) => a.per_h100e - b.per_h100e || byString(a.result_id, b.result_id),
      )
      const slowest = sorted[0]!
      const fastest = sorted.at(-1)!
      const h100e_busy = {
        low: perSecond / fastest.per_h100e,
        high: perSecond / slowest.per_h100e,
      }
      return {
        model,
        results: rs.length,
        slowest,
        fastest,
        h100e_busy,
        share: { low: h100e_busy.low / fleet.p95, high: h100e_busy.high / fleet.p5 },
      }
    })
    .sort((a, b) => a.share.high - b.share.high || byString(a.model, b.model))
  return { models, unrated_results: unrated }
}

// ── Benchmark rounds side by side ───────────────────────────────────────────

export const ROUNDS_METHOD =
  'Each row is one chip on one benchmark, at the same accelerator count in every round, so a change is the same size of system running faster or slower. ' +
  'A chip keeps the name MLPerf gives it, so the SXM and NVL versions of the H200 stay apart, and a system that mixes chips is left out. ' +
  'Each round shows its fastest result for that chip, benchmark and system size, divided by the accelerator count.'

/**
 * The chip an MLPerf accelerator string names, as a matching key and a label,
 * or null for a system that mixes chips. "[MAXSUN] MS-Intel Arc Pro B60" and
 * "AMD Instinct MI355X 288GB HBM3e (x87)" name one chip each; "… (x32), AMD
 * Instinct MI325X … (x16)" names two.
 */
export function mlperfChip(accelerator: string): { key: string; label: string } | null {
  const label = accelerator
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/\s*\(x\d+\)$/, '')
    .trim()
  if (/\(x\d+\)/.test(label)) return null
  return { key: label.toLowerCase(), label }
}

export interface RoundResult extends BenchmarkResult {
  round: string
  /** The system's accelerator count. */
  accelerators: number
  submitter: string | null
  system: string | null
}

/**
 * Pure: per chip, benchmark and accelerator count, each round's fastest
 * result, kept where two or more rounds have one. `rounds` is oldest first.
 */
export function roundRows(
  results: readonly RoundResult[],
  rounds: readonly string[],
): Pick<
  NonNullable<UtilizationData['benchmark_rounds']>,
  'rows' | 'accelerators_left_out' | 'mixed_results'
> {
  const groups = new Map<string, { chip: string; best: Map<string, RoundResult> }>()
  const chips = new Set<string>()
  const labels = new Map<string, { round: number; label: string }>()
  let mixed = 0
  for (const r of results) {
    const at = rounds.indexOf(r.round)
    if (at < 0) continue
    const chip = mlperfChip(r.accelerator)
    if (!chip) {
      mixed += 1
      continue
    }
    chips.add(chip.key)
    if ((labels.get(chip.key)?.round ?? -1) <= at)
      labels.set(chip.key, { round: at, label: chip.label })
    const key = `${chip.key}|${r.model}|${r.accelerators}`
    const group = groups.get(key) ?? { chip: chip.key, best: new Map<string, RoundResult>() }
    groups.set(key, group)
    const held = group.best.get(r.round)
    if (
      !held ||
      r.per_accelerator > held.per_accelerator ||
      (r.per_accelerator === held.per_accelerator && r.result_id < held.result_id)
    ) {
      group.best.set(r.round, r)
    }
  }
  const rows = [...groups.values()]
    .filter((g) => g.best.size >= 2)
    .map((g) => {
      const any = g.best.values().next().value!
      const present = rounds.flatMap((round) => (g.best.has(round) ? [g.best.get(round)!] : []))
      const [before, newest] = present.slice(-2) as [RoundResult, RoundResult]
      return {
        accelerator: labels.get(g.chip)!.label,
        model: any.model,
        accelerators: any.accelerators,
        results: rounds.map((round) => {
          const r = g.best.get(round)
          return r
            ? {
                per_accelerator: r.per_accelerator,
                result_id: r.result_id,
                submitter: r.submitter,
                system: r.system,
              }
            : null
        }),
        change: newest.per_accelerator / before.per_accelerator - 1,
      }
    })
    .sort(
      (a, b) =>
        byString(a.accelerator, b.accelerator) ||
        byString(a.model, b.model) ||
        a.accelerators - b.accelerators,
    )
  const shown = new Set(rows.map((r) => r.accelerator.toLowerCase()))
  return {
    rows,
    accelerators_left_out: [...chips].filter((c) => !shown.has(c)).length,
    mixed_results: mixed,
  }
}

// ── CoreWeave: revenue per megawatt ─────────────────────────────────────────

const quarterMs = (end: string): number => {
  const [y, m] = end.split('-').map(Number) as [number, number]
  return Date.parse(`${end}T00:00:00Z`) + 86_400_000 - Date.UTC(y, m - 3, 1)
}

export interface QuarterPower {
  period_end: string
  quarter: string
  active_mw: number
  qualifier: string | null
}

/** Pure: revenue per average active megawatt, quarters that have both a filed revenue and a stated power. */
export function coreweaveQuarters(
  revenue: ReadonlyMap<string, number>,
  power: readonly QuarterPower[],
): NonNullable<UtilizationData['coreweave']>['quarters'] {
  const sorted = power.toSorted((a, b) => byString(a.period_end, b.period_end))
  return sorted.flatMap((p, i) => {
    const rev = revenue.get(p.period_end)
    if (rev === undefined) return []
    const before = sorted[i - 1]
    return [
      {
        quarter: p.quarter,
        period_end: p.period_end,
        revenue_usd: rev,
        active_mw: p.active_mw,
        qualifier: p.qualifier,
        revenue_per_mw: before ? rev / ((before.active_mw + p.active_mw) / 2) : null,
      },
    ]
  })
}

/**
 * Pure: a quarter's revenue as a share of what its average active power would
 * bill at list. The low end prices an H100-equivalent at the dearest list
 * price per H100e, the high end at the cheapest.
 */
export function listPriceFloor(
  quarter: { period_end: string; revenue_usd: number; avg_active_mw: number },
  h100ePerMw: number,
  listPerH100eHour: readonly number[],
): Bounds | null {
  if (listPerH100eHour.length === 0 || !(h100ePerMw > 0)) return null
  const hours = quarterMs(quarter.period_end) / 3_600_000
  const h100eHours = quarter.avg_active_mw * h100ePerMw * hours
  return {
    low: quarter.revenue_usd / (h100eHours * Math.max(...listPerH100eHour)),
    high: quarter.revenue_usd / (h100eHours * Math.min(...listPerH100eHour)),
  }
}
