// Package downloads made comparable: raw counts of any growing AI package fit
// any other (2026-11-20 alpha audit), so the lab series are read two more ways.
//
//   normalized: npm downloads ÷ the control basket's index. The index is the
//   median, over the non-AI controls (NPM_CONTROL_RECIPES), of each control's
//   downloads as a multiple of its own mean over CONTROL_BASE. A registry-wide
//   swing moves every control and cancels; the result is downloads at
//   CONTROL_BASE's registry volume.
//   share: each lab's core SDK as a share of the tracked labs' core SDKs on
//   the same registry, per day (SHARE_SETS).
//
// Computed from recipe_observations on every read, like recipe-signals.ts, so
// nothing here is stored. A day npm reported as an outage (payload.outage) is
// left out, never read as zero. Every series has a stable id in
// DOWNLOAD_SERIES for readers outside the adoption view.

import { inArray } from 'drizzle-orm'

import type { CompanyId } from '#layers/core/shared/utils/companies'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import type { Recipe } from '#layers/core/server/recipes/contract'
import { NPM_CONTROL_RECIPES, NPM_LAB_RECIPES, NPM_WRANGLER } from './npm-downloads'
import { PYPI_LAB_RECIPES } from './pypi-downloads'

/** Four Monday-to-Sunday weeks the control index is 1.0 over. */
export const CONTROL_BASE = { from: '2025-06-02', to: '2025-06-29' } as const
/** A control needs this many clean days in CONTROL_BASE to have a base. */
const MIN_BASE_DAYS = 20

/**
 * One core API SDK per lab and registry. Agent SDKs and coding agents are
 * left out: the agent SDKs install the core SDK, so summing both would count
 * one install twice.
 */
export const SHARE_SETS = {
  npm: ['npm-openai', 'npm-anthropic-sdk', 'npm-google-genai', 'npm-mistral'],
  PyPI: ['pypi-openai', 'pypi-anthropic', 'pypi-google-genai', 'pypi-mistralai', 'pypi-xai-sdk'],
} as const satisfies Record<'npm' | 'PyPI', readonly string[]>

/** Every npm series divided by the control index: the lab packages, and wrangler. */
const NORMALIZED_RECIPES: readonly Recipe[] = [...NPM_LAB_RECIPES, NPM_WRANGLER]

export const CONTROL_INDEX_ID = 'npm-control-index'
export const normalizedId = (recipeId: string) => `${recipeId}-normalized`
export const shareId = (recipeId: string) => `${recipeId}-share`

export interface DownloadSeriesDef {
  id: string
  measure: 'normalized' | 'share' | 'control-index'
  registry: 'npm' | 'PyPI'
  company: CompanyId
  /** The recipe the series divides; null for the control index. */
  recipe_id: string | null
  unit: string
  description: string
}

const packageOf = (r: Recipe) => /^Daily \S+ downloads of (\S+),/.exec(r.description)?.[1] ?? r.id

/** Every derived download series, by stable id. */
export const DOWNLOAD_SERIES: readonly DownloadSeriesDef[] = [
  {
    id: CONTROL_INDEX_ID,
    measure: 'control-index',
    registry: 'npm',
    company: 'frontier-labs',
    recipe_id: null,
    unit: 'multiple of the control packages’ mean daily downloads over the base weeks',
    description: `Median over ${NPM_CONTROL_RECIPES.map(packageOf).join(', ')} of each one’s daily npm downloads ÷ its mean from ${CONTROL_BASE.from} to ${CONTROL_BASE.to}`,
  },
  ...NORMALIZED_RECIPES.map((r): DownloadSeriesDef => ({
    id: normalizedId(r.id),
    measure: 'normalized',
    registry: 'npm',
    company: r.company,
    recipe_id: r.id,
    unit: `downloads at the npm registry’s volume of ${CONTROL_BASE.from} to ${CONTROL_BASE.to}`,
    description: `Daily npm downloads of ${packageOf(r)} ÷ the control index`,
  })),
  ...(['npm', 'PyPI'] as const).flatMap((registry) =>
    SHARE_SETS[registry].map((id): DownloadSeriesDef => {
      const r = [...NPM_LAB_RECIPES, ...PYPI_LAB_RECIPES].find((x) => x.id === id)!
      return {
        id: shareId(id),
        measure: 'share',
        registry,
        company: r.company,
        recipe_id: id,
        unit: 'fraction (0–1)',
        description: `Daily ${registry} downloads of ${packageOf(r)} ÷ those of ${SHARE_SETS[registry].length} labs’ core SDKs`,
      }
    }),
  ),
]

export interface DayRow {
  date: string
  value: number
  /** npm reported a whole-day outage: the zero isn't a count. */
  outage: boolean
  source_url: string
  fetched_at: string
}

export interface SeriesPoint {
  date: string
  value: number
  source_url: string
  fetched_at: string
}

const DAY_MS = 86_400_000
const dayOf = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS
const dateOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10)
const round = (n: number, places = 6) => Math.round(n * 10 ** places) / 10 ** places
const byDate = <T extends { date: string }>(xs: readonly T[]) => new Map(xs.map((x) => [x.date, x]))
const ascending = <T extends { date: string }>(xs: T[]) =>
  xs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const clean = (r: DayRow) => !r.outage && r.value > 0

/**
 * Pure: the control index per day. A control's base is its mean over the
 * base weeks' clean days; a day is indexed only when every control with a
 * base has a clean value, so the median is always over the same packages.
 */
export function controlIndex(
  controls: readonly (readonly DayRow[])[],
  base: { from: string; to: string } = CONTROL_BASE,
): SeriesPoint[] {
  const based = controls.flatMap((rows) => {
    const inBase = rows.filter((r) => r.date >= base.from && r.date <= base.to && clean(r))
    if (inBase.length < MIN_BASE_DAYS) return []
    const mean = inBase.reduce((s, r) => s + r.value, 0) / inBase.length
    return [{ mean, at: byDate(rows) }]
  })
  if (based.length === 0) return []
  const dates = [...based[0]!.at.keys()]
  const out: SeriesPoint[] = []
  for (const date of dates) {
    const hits = based.map((c) => ({ c, r: c.at.get(date) }))
    if (!hits.every((h) => h.r && clean(h.r))) continue
    const newest = hits.reduce((a, b) => (b.r!.fetched_at > a.r!.fetched_at ? b : a)).r!
    out.push({
      date,
      value: round(median(hits.map((h) => h.r!.value / h.c.mean))),
      source_url: newest.source_url,
      fetched_at: newest.fetched_at,
    })
  }
  return ascending(out)
}

/** Pure: a package's downloads ÷ the control index, on every day both have. */
export function normalizedSeries(rows: readonly DayRow[], index: readonly SeriesPoint[]) {
  const at = byDate(index)
  const out: SeriesPoint[] = []
  for (const r of rows) {
    const c = at.get(r.date)
    if (r.outage || !c || c.value <= 0) continue
    out.push({
      date: r.date,
      value: round(r.value / c.value, 2),
      source_url: r.source_url,
      fetched_at: r.fetched_at,
    })
  }
  return ascending(out)
}

/**
 * Pure: each member's share of the members' total, on every day all of them
 * have a row, none an outage, and the total isn't zero.
 */
export function shareSeries(members: ReadonlyMap<string, readonly DayRow[]>) {
  const ats = [...members.entries()].map(([id, rows]) => ({ id, at: byDate(rows) }))
  const out = new Map<string, SeriesPoint[]>(ats.map((m) => [m.id, []]))
  const totals: { date: string; value: number }[] = []
  if (ats.length === 0) return { shares: out, totals }
  for (const date of ats[0]!.at.keys()) {
    const day = ats.map((m) => ({ id: m.id, r: m.at.get(date) }))
    if (!day.every((d) => d.r && !d.r.outage)) continue
    const total = day.reduce((s, d) => s + d.r!.value, 0)
    if (total <= 0) continue
    totals.push({ date, value: total })
    for (const d of day) {
      out.get(d.id)!.push({
        date,
        value: round(d.r!.value / total),
        source_url: d.r!.source_url,
        fetched_at: d.r!.fetched_at,
      })
    }
  }
  for (const xs of out.values()) ascending(xs)
  return { shares: out, totals: ascending(totals) }
}

export interface RatioWeek {
  /** The Monday, YYYY-MM-DD. */
  week: string
  /** Days of the week both series have. */
  days: number
  value: number
}

/**
 * Pure: per ISO week (Monday to Sunday, UTC), scale × Σ num ÷ Σ den over the
 * days both carry, through the newest week whose Sunday is in `num`. A ratio
 * of sums over the same days stays fair when a day is missing, which a sum
 * alone doesn't.
 */
export function weeklyRatio(
  num: readonly { date: string; value: number }[],
  den: readonly { date: string; value: number }[],
  scale = 1,
): RatioWeek[] {
  const d = byDate(den)
  const last = num.reduce((m, p) => Math.max(m, dayOf(p.date)), -Infinity)
  const mondayOf = (n: number) => n - ((n + 3) % 7)
  const weeks = new Map<number, { days: number; num: number; den: number }>()
  for (const p of num) {
    const q = d.get(p.date)
    const n = dayOf(p.date)
    if (!q || mondayOf(n) + 6 > last) continue
    const w = weeks.get(mondayOf(n)) ?? { days: 0, num: 0, den: 0 }
    w.days++
    w.num += p.value
    w.den += q.value
    weeks.set(mondayOf(n), w)
  }
  return [...weeks.entries()]
    .filter(([, w]) => w.den > 0)
    .sort(([a], [b]) => a - b)
    .map(([monday, w]) => ({
      week: dateOf(monday),
      days: w.days,
      value: round((scale * w.num) / w.den),
    }))
}

/**
 * Pure: for each date, `days` × Σ num ÷ Σ den over the trailing `days` both
 * carry, where at least `minDays` of them do. For normalized downloads, num
 * is the raw count and den the control index, so the value is the window's
 * downloads at the base weeks' registry volume. For a share, scale is 1.
 */
export function trailingRatio(
  num: readonly SeriesPoint[],
  den: readonly { date: string; value: number }[],
  days: number,
  minDays: number,
  scale: number = days,
) {
  const n = new Map(num.map((p) => [dayOf(p.date), p]))
  const d = new Map(den.map((p) => [dayOf(p.date), p.value]))
  const out: (SeriesPoint & { num: number; den: number; days: number })[] = []
  if (n.size === 0) return out
  const first = Math.min(...n.keys())
  const last = Math.max(...n.keys())
  // Every calendar day, so a window that ends on a day left out still reads.
  for (let end = first; end <= last; end++) {
    let sn = 0
    let sd = 0
    let k = 0
    let p: SeriesPoint | null = null
    for (let t = end - days + 1; t <= end; t++) {
      const a = n.get(t)
      const b = d.get(t)
      if (!a || b === undefined) continue
      sn += a.value
      sd += b
      k++
      if (!p || a.fetched_at > p.fetched_at) p = a
    }
    if (k < minDays || sd <= 0 || !p) continue
    out.push({
      date: dateOf(end),
      source_url: p.source_url,
      fetched_at: p.fetched_at,
      value: round((scale * sn) / sd, scale === 1 ? 6 : 2),
      num: sn,
      den: round(sd),
      days: k,
    })
  }
  return ascending(out)
}

type Row = typeof tables.recipeObservations.$inferSelect

export function dayRows(rows: readonly Row[]): DayRow[] {
  return ascending(
    rows
      .filter((r) => r.value !== null)
      .map((r) => {
        let outage = false
        try {
          outage = (JSON.parse(r.payload) as { outage?: unknown }).outage === true
        } catch {
          outage = false
        }
        return {
          date: r.date,
          value: r.value!,
          outage,
          source_url: r.source_url,
          fetched_at: r.fetched_at,
        }
      }),
  )
}

export interface DownloadSeries {
  /** The stored daily rows each series was computed from, by recipe id. */
  rows: ReadonlyMap<string, readonly DayRow[]>
  index: SeriesPoint[]
  normalized: ReadonlyMap<string, SeriesPoint[]>
  share: ReadonlyMap<string, SeriesPoint[]>
  /** Each registry's core SDK total, on the days its shares are read. */
  share_totals: Readonly<Record<keyof typeof SHARE_SETS, { date: string; value: number }[]>>
  /** Days every control reported as an npm outage, ascending. */
  outage_days: string[]
}

/** Every recipe the derived series read. */
export const DOWNLOAD_SERIES_RECIPES: readonly string[] = [
  ...new Set([
    ...NPM_CONTROL_RECIPES.map((r) => r.id),
    ...NORMALIZED_RECIPES.map((r) => r.id),
    ...SHARE_SETS.npm,
    ...SHARE_SETS.PyPI,
  ]),
]

/** Pure: every derived series from the stored rows, by recipe id. */
export function deriveDownloadSeries(rows: ReadonlyMap<string, readonly DayRow[]>): DownloadSeries {
  const of = (id: string) => rows.get(id) ?? []
  const controls = NPM_CONTROL_RECIPES.map((r) => of(r.id))
  const index = controlIndex(controls)
  const normalized = new Map(
    NORMALIZED_RECIPES.map((r) => [r.id, normalizedSeries(of(r.id), index)] as const),
  )
  const share = new Map<string, SeriesPoint[]>()
  const share_totals: Record<keyof typeof SHARE_SETS, { date: string; value: number }[]> = {
    npm: [],
    PyPI: [],
  }
  for (const registry of ['npm', 'PyPI'] as const) {
    const { shares, totals } = shareSeries(new Map(SHARE_SETS[registry].map((id) => [id, of(id)])))
    for (const [id, xs] of shares) share.set(id, xs)
    share_totals[registry] = totals
  }
  const flagged = controls.map((rs) => new Set(rs.filter((r) => r.outage).map((r) => r.date)))
  const outage_days =
    controls.length && controls.every((rs) => rs.length)
      ? [...flagged[0]!].filter((d) => flagged.every((f) => f.has(d))).sort()
      : []
  return { rows, index, normalized, share, share_totals, outage_days }
}

export async function readDownloadSeries(db: PipelineDb): Promise<DownloadSeries> {
  const stored = await db
    .select()
    .from(tables.recipeObservations)
    .where(inArray(tables.recipeObservations.recipe_id, [...DOWNLOAD_SERIES_RECIPES]))
  const by = new Map<string, Row[]>()
  for (const r of stored) by.set(r.recipe_id, [...(by.get(r.recipe_id) ?? []), r])
  return deriveDownloadSeries(new Map([...by].map(([id, rs]) => [id, dayRows(rs)])))
}

/** One derived series by its DOWNLOAD_SERIES id, oldest first; null for an unknown id. */
export function seriesById(series: DownloadSeries, id: string): SeriesPoint[] | null {
  const def = DOWNLOAD_SERIES.find((s) => s.id === id)
  if (!def) return null
  if (def.measure === 'control-index') return series.index
  const of = def.measure === 'normalized' ? series.normalized : series.share
  return of.get(def.recipe_id!) ?? []
}
