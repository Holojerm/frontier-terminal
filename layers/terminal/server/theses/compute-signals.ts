// The Compute thesis's measured signals. Two read today's state and cannot be
// recomputed for a past day — the flagship prices (the class map is code,
// not a stored history) and the token-price-to-GPU ratio built on them — so
// each run writes only its newest reading. The other two rebuild their whole
// history from stored rows, as the Anthropic thesis's do. The arithmetic is
// pure and exported for layers/terminal/test/theses-compute.test.ts.

import { and, desc, eq, lt, max } from 'drizzle-orm'

import type { LabId } from '../../shared/utils/terminal-types'
import type { SignalSpec } from '../../shared/utils/thesis-types'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import { queryContext, queryHiringHistory, queryPrices } from '../utils/terminal-db'
import { rankingObservations } from '../utils/terminal-rankings'
import { PROVIDER_ORDER } from '../utils/terminal-sources'
import { gpuPricePayload, type GpuModel } from './recipes/gpu-prices'
import { GPU_RECIPES } from './recipes/registry'
import type { SignalDeps, SignalReading } from './signals'

type Spec<S extends string> = Extract<SignalSpec, { signal: S }>

const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places

interface Prov {
  source_url: string
  fetched_at: string
}

const newest = <T extends Prov>(xs: readonly T[]): T =>
  xs.reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** (input × wi + output × wo) ÷ (wi + wo), USD per million tokens. */
export const blendedPrice = (input: number, output: number, wi: number, wo: number) =>
  (input * wi + output * wo) / (wi + wo)

// ---- flagship prices ---------------------------------------------------------

export interface FlagshipPrice extends Prov {
  model_slug: string
  input_per_mtok: number
  output_per_mtok: number
  blended: number
  /** false when the vendor sentence the mapping quotes was gone at the last poll. */
  basis_current: boolean | null
}

export interface FlagshipState {
  date: string
  median: number | null
  flagships: Partial<Record<LabId, FlagshipPrice>>
  /** Labs left out, and why: no mapped flagship, or a mapped one with no input and output price. */
  excluded: Partial<Record<LabId, string>>
}

/** Each lab's mapped flagship at its blended list price, from the price matrix the site shows. */
async function flagshipState(
  db: PipelineDb,
  weights: { input_weight: number; output_weight: number },
  deps: SignalDeps,
): Promise<FlagshipState> {
  const prices = await queryPrices(db, queryContext(deps.sourcesYaml, null, deps.now))
  const flagships: FlagshipState['flagships'] = {}
  const excluded: FlagshipState['excluded'] = {}
  for (const cell of prices.matrix.cells) {
    if (cell.class !== 'flagship') continue
    const row = cell.row
    if (!row || cell.basis === null) {
      excluded[cell.provider] = 'no mapped flagship'
      continue
    }
    if (row.input_per_mtok === null || row.output_per_mtok === null) {
      excluded[cell.provider] = `${row.model_slug} has no input and output list price`
      continue
    }
    flagships[cell.provider] = {
      model_slug: row.model_slug,
      input_per_mtok: row.input_per_mtok,
      output_per_mtok: row.output_per_mtok,
      blended: round(
        blendedPrice(
          row.input_per_mtok,
          row.output_per_mtok,
          weights.input_weight,
          weights.output_weight,
        ),
      ),
      basis_current: cell.basis_current,
      source_url: row.source_url,
      fetched_at: row.fetched_at,
    }
  }
  const m = median(Object.values(flagships).map((f) => f.blended))
  return {
    date: deps.now().toISOString().slice(0, 10),
    median: m === null ? null : round(m),
    flagships,
    excluded,
  }
}

/** Labs whose mapped flagship differs from the claim's previous reading — a step to explain, not a revision. */
async function flagshipChanges(
  db: PipelineDb,
  claimId: string,
  state: FlagshipState,
): Promise<Partial<Record<LabId, { from: string; to: string }>> | null> {
  const [prev] = await db
    .select({ detail: tables.claimReadings.detail })
    .from(tables.claimReadings)
    .where(
      and(eq(tables.claimReadings.claim_id, claimId), lt(tables.claimReadings.date, state.date)),
    )
    .orderBy(desc(tables.claimReadings.date))
    .limit(1)
  if (!prev) return null
  const before = (
    JSON.parse(prev.detail) as { flagships?: Record<string, { model_slug?: string }> }
  ).flagships
  const out: Partial<Record<LabId, { from: string; to: string }>> = {}
  for (const [lab, now] of Object.entries(state.flagships) as [LabId, FlagshipPrice][]) {
    const was = before?.[lab]?.model_slug
    if (was && was !== now.model_slug) out[lab] = { from: was, to: now.model_slug }
  }
  return Object.keys(out).length ? out : null
}

const flagshipDetail = (s: FlagshipState) => ({
  flagships: s.flagships,
  no_flagship: s.excluded,
})

/** Median flagship blended price across the labs with a mapped, priced flagship. */
export async function flagshipBlendedPrice(
  db: PipelineDb,
  claimId: string,
  spec: Spec<'flagship-blended-price'>,
  deps: SignalDeps,
): Promise<SignalReading[]> {
  const state = await flagshipState(db, spec, deps)
  if (state.median === null) return []
  const flagship_changed = await flagshipChanges(db, claimId, state)
  return [
    {
      date: state.date,
      value: state.median,
      detail: { ...flagshipDetail(state), flagship_changed, compare: null },
      ...pick(newest(Object.values(state.flagships))),
    },
  ]
}

const pick = (p: Prov): Prov => ({ source_url: p.source_url, fetched_at: p.fetched_at })

// ---- GPU rental prices -------------------------------------------------------

export interface GpuObservation extends Prov {
  provider: string
  gpu: GpuModel
  counted: boolean
  value: number
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
 */
export async function gpuState(db: PipelineDb): Promise<GpuState> {
  const observations: GpuObservation[] = []
  const failed: Record<string, string> = {}
  for (const recipe of GPU_RECIPES) {
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
    const [newestDate] = await db
      .select({ at: max(tables.recipeObservations.date) })
      .from(tables.recipeObservations)
      .where(eq(tables.recipeObservations.recipe_id, recipe.id))
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
        gpu: payload.gpu,
        counted: payload.counted,
        value: r.value,
        source_url: r.source_url,
        fetched_at: r.fetched_at,
      })
    }
  }
  return { observations, failed }
}

/** Median flagship blended price ÷ median on-demand GPU-hour price. */
export async function flagshipPriceToGpu(
  db: PipelineDb,
  claimId: string,
  spec: Spec<'flagship-price-to-gpu'>,
  deps: SignalDeps,
): Promise<SignalReading[]> {
  const [flag, gpus] = await Promise.all([flagshipState(db, spec, deps), gpuState(db)])
  const main = gpuMedian(spec.gpu, gpus.observations)
  const context = gpuMedian(spec.context_gpu, gpus.observations)
  if (flag.median === null || main.median === null) return []
  const have = Object.keys(main.providers).length
  const ratio = (m: number | null) => (m === null ? null : round(flag.median! / m))
  const inputs = [...Object.values(flag.flagships), ...Object.values(main.providers)]
  return [
    {
      date: flag.date,
      value: ratio(main.median)!,
      detail: {
        flagship_median: flag.median,
        ...flagshipDetail(flag),
        flagship_changed: await flagshipChanges(db, claimId, flag),
        gpu: spec.gpu,
        gpu_median: main.median,
        gpu_providers: main.providers,
        gpu_failed: gpus.failed,
        context: {
          gpu: spec.context_gpu,
          gpu_median: context.median,
          ratio: ratio(context.median),
          providers: context.providers,
        },
        quorum: { have, need: spec.min_providers },
        void_reason:
          have < spec.min_providers
            ? `${have} of the ${spec.min_providers} ${spec.gpu} providers the median needs had a price today.`
            : null,
        compare: null,
      },
      ...pick(newest(inputs)),
    },
  ]
}

// ---- demand and buildout -------------------------------------------------------

/** The tracked labs' share of all OpenRouter tokens over each trailing 7 days present. */
export async function labsCombinedShare(
  db: PipelineDb,
  historyDays: number,
): Promise<SignalReading[]> {
  const rows = await rankingObservations(db, historyDays)
  const dates = [...new Set(rows.map((r) => r.date))].sort()
  const out: SignalReading[] = []
  for (let i = 6; i < dates.length; i++) {
    const window = new Set(dates.slice(i - 6, i + 1))
    const inWindow = rows.filter((r) => window.has(r.date))
    const total = inWindow.reduce((n, r) => n + r.total_tokens, 0)
    if (total === 0) continue
    const byLab = Object.fromEntries(PROVIDER_ORDER.map((p) => [p, 0])) as Record<LabId, number>
    for (const r of inWindow) if (r.provider !== 'other') byLab[r.provider] += r.total_tokens
    const labs = PROVIDER_ORDER.reduce((n, p) => n + byLab[p], 0)
    out.push({
      date: dates[i]!,
      value: round(labs / total),
      detail: {
        window: { from: dates[i - 6], to: dates[i] },
        shares: Object.fromEntries(PROVIDER_ORDER.map((p) => [p, round(byLab[p] / total)])),
        compare: null,
      },
      ...pick(newest(inWindow)),
    })
  }
  return out
}

/** One lab's cluster series, as the hiring history reconstructs it. */
export interface LabSeries extends Prov {
  lab: LabId
  dates: readonly string[]
  series: readonly number[]
}

/**
 * The cluster summed over the labs with a feed, per date any of them has. A
 * lab counts from its first date on, at its newest point at or before the
 * date; a lab whose board starts later raises the sum from that day.
 */
export function sumAcrossLabs(labs: readonly LabSeries[]): {
  date: string
  value: number
  by_lab: Partial<Record<LabId, number>>
  prov: Prov
}[] {
  const dates = [...new Set(labs.flatMap((l) => l.dates))].sort()
  return dates.map((date) => {
    const by_lab: Partial<Record<LabId, number>> = {}
    for (const l of labs) {
      const i = l.dates.findLastIndex((d) => d <= date)
      if (i >= 0) by_lab[l.lab] = l.series[i] ?? 0
    }
    const present = labs.filter((l) => l.lab in by_lab)
    return {
      date,
      value: Object.values(by_lab).reduce((n, v) => n + v, 0),
      by_lab,
      prov: pick(newest(present)),
    }
  })
}

/** Open roles in a department cluster, summed across every lab whose board has a public feed. */
export async function clusterRolesAcrossLabs(
  db: PipelineDb,
  spec: Spec<'cluster-roles-across-labs'>,
  deps: SignalDeps,
): Promise<SignalReading[]> {
  const history = await queryHiringHistory(db, queryContext(deps.sourcesYaml, null, deps.now))
  const no_feed: Partial<Record<LabId, string>> = {}
  const labs: LabSeries[] = []
  for (const p of history.providers) {
    const source = p.sources[0]
    const cluster = p.clusters.find((c) => c.id === spec.cluster)
    // A lab with no feed, or a feed that has stored nothing yet, is named as
    // such and left out of the sum: never counted as zero.
    if (p.feed !== 'ok' || !source) {
      no_feed[p.provider] =
        p.feed === 'no_public_feed'
          ? (p.reason ?? 'no public hiring feed')
          : 'feed registered, no rows stored yet'
      continue
    }
    if (!cluster) throw new Error(`no ${spec.cluster} cluster on the ${p.provider} board`)
    labs.push({ lab: p.provider, dates: p.dates, series: cluster.series, ...pick(source) })
  }
  return sumAcrossLabs(labs).map((p) => ({
    date: p.date,
    value: p.value,
    detail: { by_lab: p.by_lab, no_feed, compare: null },
    ...p.prov,
  }))
}
