// The GPU price series: observations for a day and each GPU's median across
// providers, one vote each. Every reader of GPU prices goes through here.

import { and, desc, eq, lte, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { gpuPricePayload, type GpuModel } from './gpu-prices'
import { GPU_RECIPES } from './gpu-recipes'

const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places

interface Prov {
  source_url: string
  fetched_at: string
}

const newest = <T extends Prov>(xs: readonly T[]): T =>
  xs.reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))

const pick = (p: Prov): Prov => ({ source_url: p.source_url, fetched_at: p.fetched_at })

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export interface GpuObservation extends Prov {
  provider: string
  /** The recipe observation's key (one configuration and region) and date; gpuState sets both. */
  key?: string
  date?: string
  gpu: GpuModel
  counted: boolean
  value: number
  /** The row's spot price range per GPU-hour, where its page prints one (terminal-utilization.ts). */
  spot_low?: number | null
  spot_high?: number | null
}

export interface GpuProviderPrice extends Prov {
  /** The median of the provider's counted rows: each provider is one vote. */
  value: number
  rows: number
}

export interface GpuMedian {
  gpu: GpuModel
  median: number | null
  providers: Record<string, GpuProviderPrice>
}

/** Per provider, the median of its counted rows; across providers, the median of those. */
export function gpuMedian(gpu: GpuModel, obs: readonly GpuObservation[]): GpuMedian {
  const byProvider = new Map<string, GpuObservation[]>()
  for (const o of obs) {
    if (o.gpu !== gpu || !o.counted) continue
    byProvider.set(o.provider, [...(byProvider.get(o.provider) ?? []), o])
  }
  const providers: Record<string, GpuProviderPrice> = {}
  for (const [provider, rows] of [...byProvider].sort(([a], [b]) => (a < b ? -1 : 1))) {
    providers[provider] = {
      value: round(median(rows.map((r) => r.value))!),
      rows: rows.length,
      ...pick(newest(rows)),
    }
  }
  const m = median(Object.values(providers).map((p) => p.value))
  return { gpu, median: m === null ? null : round(m), providers }
}

export interface GpuState {
  observations: GpuObservation[]
  /** Providers whose newest run failed, so none of their prices count today. */
  failed: Record<string, string>
}

/**
 * Today's prices: for each GPU recipe whose newest run succeeded (fetched, or
 * fetched and unchanged), the observations of its newest stored date. A key
 * the page stopped printing keeps an older date and drops out.
 *
 * With `through` (a YYYY-MM-DD date), the prices as they stood that day
 * instead: each recipe's newest stored date on or before it. A changed page
 * stores its whole set under the day it was read, so that date's rows are the
 * page as it was. Runs are not consulted: what was stored is the read.
 */
export async function gpuState(db: PipelineDb, opts: { through?: string } = {}): Promise<GpuState> {
  const observations: GpuObservation[] = []
  const failed: Record<string, string> = {}
  for (const recipe of GPU_RECIPES) {
    if (!opts.through) {
      const [run] = await db
        .select({ status: tables.recipeRuns.status, detail: tables.recipeRuns.detail })
        .from(tables.recipeRuns)
        .where(eq(tables.recipeRuns.recipe_id, recipe.id))
        .orderBy(desc(tables.recipeRuns.started_at))
        .limit(1)
      if (!run) continue
      if (run.status === 'failed') {
        failed[recipe.company] = run.detail ?? 'failed'
        continue
      }
    }
    const [newestDate] = await db
      .select({ at: max(tables.recipeObservations.date) })
      .from(tables.recipeObservations)
      .where(
        and(
          eq(tables.recipeObservations.recipe_id, recipe.id),
          opts.through ? lte(tables.recipeObservations.date, opts.through) : undefined,
        ),
      )
    if (!newestDate?.at) continue
    const rows = await db
      .select()
      .from(tables.recipeObservations)
      .where(
        and(
          eq(tables.recipeObservations.recipe_id, recipe.id),
          eq(tables.recipeObservations.date, newestDate.at),
        ),
      )
    for (const r of rows) {
      const payload = gpuPricePayload.parse(JSON.parse(r.payload))
      if (r.value === null) continue
      observations.push({
        provider: payload.provider,
        key: r.key,
        date: r.date,
        gpu: payload.gpu,
        counted: payload.counted,
        value: r.value,
        spot_low: payload.spot_low_usd_per_gpu_hour,
        spot_high: payload.spot_high_usd_per_gpu_hour,
        source_url: r.source_url,
        fetched_at: r.fetched_at,
      })
    }
  }
  return { observations, failed }
}
