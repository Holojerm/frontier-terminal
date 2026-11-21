// GET /api/gpu-prices and the get_gpu_prices MCP tool: today's on-demand GPU
// rental prices from the GPU recipes, every row with its provider page and
// fetch time, the equal-weight medians the Compute thesis divides by, and the
// archived weekly series from before the recipes began (terminal-gpu-archive.ts).

import { count, desc, eq, inArray, max } from 'drizzle-orm'

import { gpuProviderName } from '#layers/core/shared/utils/companies'
import type { GpuHistoryView, GpuPricesData } from '../../shared/utils/terminal-types/gpu-prices'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { gpuMedian, gpuState, type GpuObservation } from '../recipes/gpu-series'
import { GPU_MODELS, gpuPricePayload } from '../recipes/gpu-prices'
import { GPU_RECIPES } from '../recipes/gpu-recipes'
import { recipeRunsStamp, type QueryContext } from '#layers/core/server/utils/terminal-db'
import { queryGpuArchive } from './terminal-gpu-archive'
import { byString } from '#layers/core/server/utils/terminal-json'
import { SPOT_QUORUM, spotRead } from './terminal-utilization'

export const GPU_PRICES_METHOD =
  'On-demand list prices from first-party price pages and documented price APIs, in USD per GPU-hour (an instance price divided by its GPUs). ' +
  'Each provider counts once, at the median of its own counted rows (configurations and regions). The figure shown is the median across providers. ' +
  'We count SXM and HGX boards and rows that print no form factor. We keep PCIe and NVL cards but leave them out of the median, so it compares like with like.'

export const GPU_PRICES_CAVEAT =
  'These are list prices. Reserved terms, spot markets, and negotiated contracts are lower. When we audited these sources, a marketplace such as Vast.ai listed H100 SXM offers at about half the first-party median. ' +
  'If a provider’s page failed today, we name it and leave it out. We don’t carry an old price forward.'

export const GPU_HISTORY_METHOD =
  'One point for each day a provider’s page changed, then today’s read. A page that didn’t change keeps its last price. ' +
  'The median counts the providers priced that day, so it can move when we add a provider or a page fails, with no price changing. Each such day is noted under the chart. ' +
  'The spot share is a spot price divided by the on-demand price for the same instance on the same page. ' +
  `We show each provider’s share on its own until ${SPOT_QUORUM} providers print a spot price for the same GPU. ` +
  'Where a page prints two spot prices, the chart follows the lower one and the table has both.'

/** The cache variant: the newest GPU recipe run, and the newest archived copy a backfill wrote. */
export async function gpuRunsStamp(db: PipelineDb): Promise<string> {
  const [runs, [archived]] = await Promise.all([
    recipeRunsStamp(
      db,
      GPU_RECIPES.map((r) => r.id),
    ),
    db
      .select({ at: max(tables.archiveCaptures.fetched_at), n: count() })
      .from(tables.archiveCaptures)
      .where(eq(tables.archiveCaptures.axis, 'gpu')),
  ])
  return archived?.n ? `${runs}|archive:${archived.n}:${archived.at}` : runs
}

/** One stored price row, with the recipe that stored it and the day it was read. */
export type StoredGpuRead = GpuObservation & { recipe_id: string; date: string }

/**
 * Pure: the medians and spot shares on each day a provider's page changed.
 * A recipe stores its whole page under the day it read a change, so the
 * prices on a day are each recipe's newest stored date on or before it.
 *
 * `newest` is today's read as the snapshot panels count it (a provider whose
 * run failed today is left out), and it is the last point, so the end of each
 * line is the number the panel beside it prints.
 */
export function gpuHistory(
  stored: readonly StoredGpuRead[],
  newest: { date: string; observations: readonly GpuObservation[] } | null,
): GpuHistoryView {
  const byRecipe = new Map<string, Map<string, StoredGpuRead[]>>()
  for (const r of stored) {
    const dates = byRecipe.get(r.recipe_id) ?? new Map<string, StoredGpuRead[]>()
    const rows = dates.get(r.date) ?? []
    rows.push(r)
    dates.set(r.date, rows)
    byRecipe.set(r.recipe_id, dates)
  }
  const reads: { date: string; observations: readonly GpuObservation[] }[] = [
    ...new Set(stored.map((r) => r.date)),
  ]
    .filter((date) => !newest || date < newest.date)
    .sort(byString)
    .map((date) => ({
      date,
      observations: [...byRecipe.values()].flatMap((dates) => {
        const at = [...dates.keys()]
          .filter((d) => d <= date)
          .sort(byString)
          .at(-1)
        return at ? dates.get(at)! : []
      }),
    }))
  if (newest) reads.push(newest)

  const spots = reads.map((r) => spotRead(r.observations))
  return {
    dates: reads.map((r) => r.date),
    gpus: GPU_MODELS.map((gpu) => {
      const medians = reads.map((r) => gpuMedian(gpu, r.observations))
      const names = new Map<string, string>()
      for (const s of spots) {
        for (const p of s.providers) if (p.gpu === gpu) names.set(p.provider, p.provider_name)
      }
      const counted = medians.map((m) => Object.keys(m.providers))
      return {
        gpu,
        median: medians.map((m) => m.median),
        providers: counted.map((ids) => ids.length),
        provider_changes: counted.flatMap((ids, i) => {
          if (i === 0) return []
          const was = counted[i - 1]!
          const joined = ids.filter((id) => !was.includes(id)).map(gpuProviderName)
          const left = was.filter((id) => !ids.includes(id)).map(gpuProviderName)
          return joined.length || left.length ? [{ date: reads[i]!.date, joined, left }] : []
        }),
        spot_combined: spots.map((s) => s.combined.find((c) => c.gpu === gpu)?.ratio ?? null),
        spot: [...names]
          .sort(([a], [b]) => byString(a, b))
          .map(([provider, provider_name]) => ({
            provider,
            provider_name,
            share: spots.map(
              (s) =>
                s.providers.find((p) => p.provider === provider && p.gpu === gpu)?.ratio ?? null,
            ),
          })),
      }
    }),
    spot_providers_needed: SPOT_QUORUM,
    method: GPU_HISTORY_METHOD,
  }
}

export async function queryGpuPrices(db: PipelineDb, ctx: QueryContext): Promise<GpuPricesData> {
  const [state, archived] = await Promise.all([gpuState(db), queryGpuArchive(db)])
  const ids = GPU_RECIPES.map((r) => r.id)
  const rows = await db
    .select()
    .from(tables.recipeObservations)
    .where(inArray(tables.recipeObservations.recipe_id, ids))
    .orderBy(desc(tables.recipeObservations.date))
  // The same rows gpuState read: each recipe's newest date, for recipes whose newest run succeeded.
  const newest = new Map<string, string>()
  for (const r of rows) if (!newest.has(r.recipe_id)) newest.set(r.recipe_id, r.date)
  const failed = new Set(Object.keys(state.failed))
  const parsed = rows
    .filter((r) => r.value !== null)
    .map((r) => ({ r, p: gpuPricePayload.parse(JSON.parse(r.payload)) }))
  const history = gpuHistory(
    parsed.map(({ r, p }) => ({
      recipe_id: r.recipe_id,
      date: r.date,
      provider: p.provider,
      gpu: p.gpu,
      counted: p.counted,
      value: r.value!,
      spot_low: p.spot_low_usd_per_gpu_hour,
      spot_high: p.spot_high_usd_per_gpu_hour,
      source_url: r.source_url,
      fetched_at: r.fetched_at,
    })),
    state.observations.length
      ? { date: ctx.now().toISOString().slice(0, 10), observations: state.observations }
      : null,
  )
  const prices = parsed
    .filter(({ r }) => r.date === newest.get(r.recipe_id))
    .map(({ r, p }) => {
      return {
        provider: p.provider,
        provider_name: gpuProviderName(p.provider),
        key: r.key,
        gpu: p.gpu,
        form_factor: p.form_factor,
        counted: p.counted,
        label: p.label,
        usd_per_gpu_hour: r.value!,
        gpus_per_instance: p.gpus_per_instance,
        instance_usd_per_hour: p.instance_usd_per_hour,
        region: p.region,
        config: p.config,
        source_url: r.source_url,
        fetched_at: r.fetched_at,
      }
    })
    .filter((p) => !failed.has(p.provider))
    .sort(
      (a, b) =>
        byString(b.gpu, a.gpu) || byString(a.provider, b.provider) || byString(a.key, b.key),
    )
  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    medians: GPU_MODELS.map((gpu) => {
      const m = gpuMedian(gpu, state.observations)
      return {
        gpu,
        median: m.median,
        providers: Object.entries(m.providers).map(([provider, v]) => ({
          provider,
          provider_name: gpuProviderName(provider),
          usd_per_gpu_hour: v.value,
          rows: v.rows,
          source_url: v.source_url,
          fetched_at: v.fetched_at,
        })),
      }
    }),
    history,
    archived,
    prices,
    failed: Object.entries(state.failed).map(([provider, detail]) => ({
      provider,
      provider_name: gpuProviderName(provider),
      detail,
    })),
    method: GPU_PRICES_METHOD,
    caveat: GPU_PRICES_CAVEAT,
  }
}
