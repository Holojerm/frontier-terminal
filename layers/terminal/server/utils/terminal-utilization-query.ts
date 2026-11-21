// GET /api/utilization and the get_utilization MCP tool: the compute layer's
// utilization reads (layers/compute/server/utils/terminal-utilization.ts) set
// beside the two that come from other domains, CoreWeave's XBRL revenue and
// OpenRouter's demand shape. It stays in the shell until those domains have
// layers of their own that compute may read.

import { inArray } from 'drizzle-orm'

import type { UtilizationData } from '#layers/compute/shared/utils/compute-views'
import type { RecipeCitation } from '#layers/core/shared/utils/terminal-types/common'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { gpuState, median } from '#layers/compute/server/recipes/gpu-series'
import {
  SEC_CRWV_ACTIVE_POWER,
  SEC_GOOGL_API_TOKENS,
} from '#layers/compute/server/recipes/earnings-releases'
import { EPOCH_CHIP_TYPES, EPOCH_CHIP_USERS } from '#layers/compute/server/recipes/epoch-chip-users'
import { EPOCH_DATA_CENTERS } from '#layers/compute/server/recipes/epoch-data-centers'
import { GPU_MODELS } from '#layers/compute/server/recipes/gpu-prices'
import {
  MLPERF_INFERENCE,
  MLPERF_ROUNDS,
  mlperfFootnote,
  mlperfRoundsFootnote,
} from '#layers/compute/server/recipes/mlperf-inference'
import { GPU_RECIPES } from '#layers/compute/server/recipes/gpu-recipes'
import {
  COREWEAVE_CAVEAT,
  COREWEAVE_METHOD,
  FLEET_KEY,
  IMPLIED_CAVEAT,
  IMPLIED_METHOD,
  ROUNDS_METHOD,
  SPOT_CAVEAT,
  SPOT_METHOD,
  SPOT_QUORUM,
  coreweaveQuarters,
  impliedRows,
  listPriceFloor,
  roundRows,
  spotRead,
} from '#layers/compute/server/utils/terminal-utilization'
import { SEC_REVENUE_CRWV } from '../theses/recipes/sec-revenue'
import { sourceReads, type QueryContext } from '#layers/core/server/utils/terminal-db'
import { byString } from '#layers/core/server/utils/terminal-json'
import {
  rankingObservations,
  rankingsAsOf,
  rankingsMeta,
  summarizeRankings,
  type RankingObservation,
} from '#layers/adoption/server/utils/terminal-rankings'

type Row = typeof tables.recipeObservations.$inferSelect

export const SHAPE_CAVEAT =
  'OpenRouter’s daily token total, average day against busiest day in the window. A fleet sized for its busiest day can’t run fuller than this on average. ' +
  'It’s one aggregator’s traffic, and a daily total hides the busiest hour, so the ceiling is lower than this.'

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
