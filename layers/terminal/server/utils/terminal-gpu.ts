// GET /api/gpu-prices and the get_gpu_prices MCP tool: today's on-demand GPU
// rental prices from the GPU recipes, every row with its provider page and
// fetch time, and the equal-weight medians the Compute thesis divides by.

import { desc, inArray } from 'drizzle-orm'

import { companyName } from '../../shared/utils/companies'
import type { GpuPricesData } from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import { gpuMedian, gpuState } from '../theses/compute-signals'
import { GPU_MODELS, gpuPricePayload } from '../theses/recipes/gpu-prices'
import { GPU_RECIPES } from '../theses/recipes/registry'
import { recipeRunsStamp, type QueryContext } from './terminal-db'
import { byString } from './terminal-json'

export const GPU_PRICES_METHOD =
  'On-demand list prices from first-party price pages and documented price APIs, normalized to USD per GPU-hour (an instance price divided by its GPUs). ' +
  'Each provider counts once, at the median of its own counted rows (configurations and regions); the figure shown is the median across providers. ' +
  'SXM and HGX boards, and rows that print no form factor, are counted; PCIe and NVL cards are kept and not counted, so the median compares like with like.'

export const GPU_PRICES_CAVEAT =
  'List prices, not what anyone pays: reserved terms, spot markets and negotiated contracts are lower, and a marketplace such as Vast.ai listed H100 SXM offers about half the first-party median when this source set was audited. ' +
  'A provider whose page failed today is named and left out, never carried forward.'

export const gpuRunsStamp = (db: PipelineDb) =>
  recipeRunsStamp(
    db,
    GPU_RECIPES.map((r) => r.id),
  )

export async function queryGpuPrices(db: PipelineDb, ctx: QueryContext): Promise<GpuPricesData> {
  const state = await gpuState(db)
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
  const prices = rows
    .filter((r) => r.date === newest.get(r.recipe_id) && r.value !== null)
    .map((r) => {
      const p = gpuPricePayload.parse(JSON.parse(r.payload))
      return {
        provider: p.provider,
        provider_name: companyName(p.provider),
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
          provider_name: companyName(provider),
          usd_per_gpu_hour: v.value,
          rows: v.rows,
          source_url: v.source_url,
          fetched_at: v.fetched_at,
        })),
      }
    }),
    prices,
    failed: Object.entries(state.failed).map(([provider, detail]) => ({
      provider,
      provider_name: companyName(provider),
      detail,
    })),
    method: GPU_PRICES_METHOD,
    caveat: GPU_PRICES_CAVEAT,
  }
}
