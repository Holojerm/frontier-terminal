// GET /api/utilization and the Compute page's utilization panels: how full
// the data centers are, as far as free public sources can say. Four reads,
// none of them a utilization figure:
//
//   spot       what a provider charges for interruptible capacity against its
//              own on-demand price for the same instance, per provider;
//   implied    Alphabet's stated tokens per minute against benchmark tokens
//              per second, as a share of Epoch's estimate of Google's fleet;
//   coreweave  revenue per megawatt of active power, from its filings;
//   shape      OpenRouter's average day against its busiest day.
//
// Beside them, benchmark_rounds sets every stored MLPerf round side by side:
// per chip and benchmark at one accelerator count, each round's fastest result
// per accelerator. The implied read uses the newest round alone.
//
// Closed labs publish no throughput and public benchmarks span two orders of
// magnitude by model size, so the implied read is a pair of bounds per
// benchmark model, the way terminal-spend.ts prints implied spend, and never
// one number. The spot read shows providers singly until SPOT_QUORUM of them
// print a spot price for the same GPU (the owner's call, 2026-11-20).
//
// The pure half (spotRead, impliedRead, roundRows, coreweaveRead, demandShape) has no
// clock and no database; layers/terminal/test/terminal-utilization.test.ts
// drives it.

import { inArray } from 'drizzle-orm'

import { gpuProviderName } from '../../shared/utils/companies'
import type {
  Bounds,
  ImpliedModelRow,
  RecipeCitation,
  SpotProviderRow,
  UtilizationData,
} from '../../shared/utils/recipe-views'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { gpuState, median, type GpuObservation } from '../theses/recipes/gpu-series'
import { SEC_CRWV_ACTIVE_POWER, SEC_GOOGL_API_TOKENS } from '../theses/recipes/earnings-releases'
import { EPOCH_CHIP_TYPES, EPOCH_CHIP_USERS } from '../theses/recipes/epoch-chip-users'
import { EPOCH_DATA_CENTERS } from '../theses/recipes/epoch-data-centers'
import { GPU_MODELS } from '../theses/recipes/gpu-prices'
import {
  MLPERF_INFERENCE,
  MLPERF_ROUNDS,
  mlperfFootnote,
  mlperfRoundsFootnote,
} from '../theses/recipes/mlperf-inference'
import { GPU_RECIPES } from '../theses/recipes/gpu-recipes'
import { SEC_REVENUE_CRWV } from '../theses/recipes/sec-revenue'
import { sourceReads, type QueryContext } from '#layers/core/server/utils/terminal-db'
import {
  rankingObservations,
  rankingsAsOf,
  rankingsMeta,
  summarizeRankings,
  type RankingObservation,
} from './terminal-rankings'

type Row = typeof tables.recipeObservations.$inferSelect

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

export const SHAPE_CAVEAT =
  'OpenRouter’s daily token total, average day against busiest day in the window. A fleet sized for its busiest day can’t run fuller than this on average. ' +
  'It’s one aggregator’s traffic, and a daily total hides the busiest hour, so the ceiling is lower than this.'

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

// ── Demand shape ────────────────────────────────────────────────────────────

/** Pure: average day against busiest day, over every day in the rows. */
export function demandShape(
  rows: readonly Pick<RankingObservation, 'date' | 'total_tokens'>[],
): Pick<
  NonNullable<UtilizationData['demand_shape']>,
  'window' | 'days' | 'mean_tokens' | 'peak_tokens' | 'peak_date' | 'ratio'
> | null {
  const byDay = new Map<string, number>()
  for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.total_tokens)
  const days = [...byDay].sort(([a], [b]) => byString(a, b))
  if (days.length < 7) return null
  const total = days.reduce((n, [, t]) => n + t, 0)
  const [peak_date, peak_tokens] = days.reduce((a, b) => (b[1] > a[1] ? b : a))
  if (!(peak_tokens > 0)) return null
  const mean_tokens = total / days.length
  return {
    window: { from: days[0]![0], to: days.at(-1)![0] },
    days: days.length,
    mean_tokens,
    peak_tokens,
    peak_date,
    ratio: mean_tokens / peak_tokens,
  }
}

// ── The query ───────────────────────────────────────────────────────────────

const payloadOf = (r: Row): Record<string, unknown> =>
  JSON.parse(r.payload) as Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const cite = (recipe_id: string, label: string, r: Row): RecipeCitation => ({
  recipe_id,
  label,
  source_url: r.source_url,
  fetched_at: r.fetched_at,
})
const newestFetched = (rows: readonly Row[]): Row | null =>
  rows.reduce<Row | null>((a, b) => (!a || b.fetched_at > a.fetched_at ? b : a), null)
/** A current-state recipe's rows: those of its newest date. */
function snapshot(rows: readonly Row[]): Row[] {
  const date = rows.reduce((m, r) => (r.date > m ? r.date : m), '')
  return rows.filter((r) => r.date === date)
}

/** Every recipe the payload reads, for the cache key. */
export const UTILIZATION_RECIPES: readonly string[] = [
  ...GPU_RECIPES.map((r) => r.id),
  SEC_GOOGL_API_TOKENS.id,
  SEC_CRWV_ACTIVE_POWER.id,
  SEC_REVENUE_CRWV.id,
  MLPERF_INFERENCE.id,
  EPOCH_CHIP_USERS.id,
  EPOCH_CHIP_TYPES.id,
  EPOCH_DATA_CENTERS.id,
]

export async function queryUtilization(
  db: PipelineDb,
  ctx: QueryContext,
): Promise<UtilizationData> {
  const ids = [
    SEC_GOOGL_API_TOKENS.id,
    SEC_CRWV_ACTIVE_POWER.id,
    SEC_REVENUE_CRWV.id,
    MLPERF_INFERENCE.id,
    EPOCH_CHIP_USERS.id,
    EPOCH_CHIP_TYPES.id,
    EPOCH_DATA_CENTERS.id,
  ]
  const [gpu, all, rankings, reads, openRouterAsOf] = await Promise.all([
    gpuState(db),
    db
      .select()
      .from(tables.recipeObservations)
      .where(inArray(tables.recipeObservations.recipe_id, ids)),
    rankingObservations(db),
    sourceReads(db),
    rankingsAsOf(db),
  ])
  const of = (id: string) => all.filter((r) => r.recipe_id === id && r.value !== null)

  const failed = new Set(Object.keys(gpu.failed))
  const prices = gpu.observations.filter((o) => !failed.has(o.provider))
  const spot = spotRead(prices)

  const chipRows = snapshot(of(EPOCH_CHIP_TYPES.id))
  const ratings = new Map(chipRows.map((r) => [r.key, r.value!]))

  // Implied load: the newest stated volume, the newest fleet estimate, the newest benchmark round stored.
  const tokenRows = of(SEC_GOOGL_API_TOKENS.id).toSorted((a, b) => byString(a.date, b.date))
  const stated = tokenRows.at(-1)
  const fleetRow = of(EPOCH_CHIP_USERS.id)
    .filter((r) => r.key === FLEET_KEY)
    .toSorted((a, b) => byString(a.date, b.date))
    .at(-1)
  // A row's date is its round's, so the newest date is the newest round stored.
  const benchRows = snapshot(of(MLPERF_INFERENCE.id))
  const benchRound = benchRows[0] ? (text(payloadOf(benchRows[0]).round) ?? '') : ''
  let implied: UtilizationData['implied'] = null
  if (stated && fleetRow && benchRows.length > 0 && chipRows.length > 0) {
    const fleet = payloadOf(fleetRow) as { p5: number; p95: number; label?: string }
    const results = benchRows.map((r) => {
      const p = payloadOf(r) as { result_id: string; model: string; accelerator: string }
      return {
        result_id: p.result_id,
        model: p.model,
        accelerator: p.accelerator,
        per_accelerator: r.value!,
      }
    })
    const tokenPayload = (r: Row) => payloadOf(r) as { quarter?: string; qualifier?: string | null }
    implied = {
      lab: 'google',
      tokens: {
        quarter: tokenPayload(stated).quarter ?? stated.date,
        period_end: stated.date,
        per_minute: stated.value!,
        qualifier: tokenPayload(stated).qualifier ?? null,
        sentence: text(payloadOf(stated).sentence) ?? '',
        source: cite(SEC_GOOGL_API_TOKENS.id, 'Alphabet earnings release (SEC)', stated),
      },
      history: tokenRows.map((r) => ({
        quarter: tokenPayload(r).quarter ?? r.date,
        period_end: r.date,
        per_minute: r.value!,
        qualifier: tokenPayload(r).qualifier ?? null,
      })),
      fleet: {
        label: fleet.label ?? 'Operational fleet',
        date: fleetRow.date,
        h100e: { p5: fleet.p5, median: fleetRow.value!, p95: fleet.p95 },
        source: cite(EPOCH_CHIP_USERS.id, 'Epoch AI, AI chip users', fleetRow),
      },
      ...impliedRows(stated.value!, fleet, results, ratings),
      benchmark: {
        round: benchRound,
        footnote: mlperfFootnote(benchRound, newestFetched(benchRows)!.fetched_at.slice(0, 10)),
        source: cite(
          MLPERF_INFERENCE.id,
          `MLPerf Inference ${benchRound} results`,
          newestFetched(benchRows)!,
        ),
      },
      chip_ratings: cite(EPOCH_CHIP_TYPES.id, 'Epoch AI, AI chip sales', newestFetched(chipRows)!),
      method: IMPLIED_METHOD,
      caveat: IMPLIED_CAVEAT,
    }
  }

  // Every stored round side by side; the implied read above keeps to the newest.
  const roundRowsStored = of(MLPERF_INFERENCE.id).map((r) => ({
    row: r,
    payload: payloadOf(r) as {
      result_id: string
      round: string
      model: string
      accelerator: string
      accelerators: number
      submitter?: string | null
      system?: string | null
    },
  }))
  const stored = MLPERF_ROUNDS.map((r) => r.round).filter((round) =>
    roundRowsStored.some((r) => r.payload.round === round),
  )
  let benchmark_rounds: UtilizationData['benchmark_rounds'] = null
  if (stored.length >= 2) {
    const newestOf = (round: string) =>
      newestFetched(roundRowsStored.filter((r) => r.payload.round === round).map((r) => r.row))!
    benchmark_rounds = {
      rounds: stored,
      ...roundRows(
        roundRowsStored.map(({ row, payload: p }) => ({
          round: p.round,
          result_id: p.result_id,
          model: p.model,
          accelerator: p.accelerator,
          accelerators: p.accelerators,
          submitter: p.submitter ?? null,
          system: p.system ?? null,
          per_accelerator: row.value!,
        })),
        stored,
      ),
      footnote: mlperfRoundsFootnote(
        stored.map((round) => ({ round, retrieved: newestOf(round).fetched_at.slice(0, 10) })),
      ),
      sources: stored.map((round) =>
        cite(MLPERF_INFERENCE.id, `MLPerf Inference ${round} results`, newestOf(round)),
      ),
      method: ROUNDS_METHOD,
    }
  }

  // CoreWeave: filed revenue per quarter beside the active power its release states.
  const powerRows = of(SEC_CRWV_ACTIVE_POWER.id)
  const revenueRows = of(SEC_REVENUE_CRWV.id).filter((r) => r.key === 'revenue')
  let coreweave: UtilizationData['coreweave'] = null
  if (powerRows.length > 0 && revenueRows.length > 0) {
    const power = powerRows.map((r) => {
      const p = payloadOf(r) as { quarter?: string; qualifier?: string | null }
      return {
        period_end: r.date,
        quarter: p.quarter ?? r.date,
        active_mw: r.value!,
        qualifier: p.qualifier ?? null,
      }
    })
    const quarters = coreweaveQuarters(new Map(revenueRows.map((r) => [r.date, r.value!])), power)
    const newest = quarters.at(-1)
    const sites = snapshot(of(EPOCH_DATA_CENTERS.id)).flatMap((r) => {
      const h100e = payloadOf(r).h100e
      return typeof h100e === 'number' && r.value! > 0 ? [{ mw: r.value!, h100e }] : []
    })
    const h100ePerMw = sites.reduce((n, s) => n + s.h100e, 0) / sites.reduce((n, s) => n + s.mw, 0)
    // CoreWeave's own on-demand price per GPU, put on Epoch's H100-equivalent scale.
    const list = GPU_MODELS.flatMap((model) => {
      const rows = prices.filter((o) => o.provider === 'coreweave' && o.gpu === model && o.counted)
      const h100e = ratings.get(model)
      const price = median(rows.map((r) => r.value))
      return price !== null && h100e ? [price / h100e] : []
    })
    const share =
      newest?.revenue_per_mw != null && sites.length > 0
        ? listPriceFloor(
            {
              period_end: newest.period_end,
              revenue_usd: newest.revenue_usd,
              avg_active_mw: newest.revenue_usd / newest.revenue_per_mw,
            },
            h100ePerMw,
            list,
          )
        : null
    const newestPower = newestFetched(powerRows)!
    const newestRevenue = newestFetched(revenueRows)!
    coreweave = {
      quarters,
      floor:
        newest && share
          ? {
              quarter: newest.quarter,
              share,
              h100e_per_mw: h100ePerMw,
              list_usd_per_h100e_hour: { low: Math.min(...list), high: Math.max(...list) },
            }
          : null,
      sources: [
        cite(SEC_CRWV_ACTIVE_POWER.id, 'CoreWeave earnings release (SEC)', newestPower),
        cite(SEC_REVENUE_CRWV.id, 'CoreWeave XBRL company facts (SEC)', newestRevenue),
      ],
      method: COREWEAVE_METHOD,
      caveat: COREWEAVE_CAVEAT,
    }
  }

  const shape = demandShape(rankings)
  const meta = rankingsMeta(
    ctx,
    rankings,
    reads,
    openRouterAsOf,
    summarizeRankings(rankings).coverage,
  )

  const stamps = [
    ...prices.map((p) => p.fetched_at),
    ...all.map((r) => r.fetched_at),
    ...(meta.provenance ? [meta.provenance.fetched_at] : []),
  ]
  return {
    as_of: stamps.reduce<string | null>((m, s) => (m === null || s > m ? s : m), null),
    spot: {
      ...spot,
      providers_needed: SPOT_QUORUM,
      method: SPOT_METHOD,
      caveat: SPOT_CAVEAT,
    },
    implied,
    benchmark_rounds,
    coreweave,
    demand_shape: shape
      ? { ...shape, source: meta.provenance, citation: meta.meta.citation, caveat: SHAPE_CAVEAT }
      : null,
  }
}
