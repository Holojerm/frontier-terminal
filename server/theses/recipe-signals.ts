// Measured signals over recipe_observations. The arithmetic is pure and
// exported for the tests; the readers below fetch a recipe's rows and hand
// them over. Every reading here can be recomputed from the stored
// observations, so the evaluator rewrites their whole history each run.

import { and, eq, inArray } from 'drizzle-orm'

import type { SignalSpec } from '#shared/utils/thesis-types'

import * as tables from '../db/schema'
import type { PipelineDb } from '../pipeline/store'
import { RECIPES } from './recipes/registry'
import type { SignalReading } from './signals'

export interface Point {
  date: string
  value: number
  source_url: string
  fetched_at: string
}

const DAY_MS = 86_400_000
const dayOf = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS
const round = (n: number) => Math.round(n * 10_000) / 10_000

/** The point a year before `date`, within three weeks either side (quarter ends drift). */
function yearEarlier(points: readonly Point[], date: string): Point | null {
  const want = dayOf(date) - 365
  let best: Point | null = null
  for (const p of points) {
    const off = Math.abs(dayOf(p.date) - want)
    if (off <= 21 && (!best || off < Math.abs(dayOf(best.date) - want))) best = p
  }
  return best
}

/** Growth against the same period a year earlier, for every period that has one. */
export function yoyGrowth(points: readonly Point[]): (Point & { base: Point })[] {
  const out: (Point & { base: Point })[] = []
  for (const p of points) {
    const base = yearEarlier(points, p.date)
    if (!base || base.value <= 0) continue
    out.push({ ...p, value: round(p.value / base.value - 1), base })
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1))
}

/** The sum over the trailing `days`, for every date whose whole window is present. */
export function trailingSum(points: readonly Point[], days: number): Point[] {
  const byDay = new Map(points.map((p) => [dayOf(p.date), p]))
  const out: Point[] = []
  for (const p of points) {
    let sum = 0
    let full = true
    for (let d = dayOf(p.date) - days + 1; d <= dayOf(p.date); d++) {
      const hit = byDay.get(d)
      if (!hit) {
        full = false
        break
      }
      sum += hit.value
    }
    if (full) out.push({ ...p, value: sum })
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1))
}

async function points(
  db: PipelineDb,
  recipe: string,
  keys: readonly string[],
): Promise<(Point & { key: string })[]> {
  const rows = await db
    .select()
    .from(tables.recipeObservations)
    .where(
      and(
        eq(tables.recipeObservations.recipe_id, recipe),
        inArray(tables.recipeObservations.key, [...keys]),
      ),
    )
  return rows
    .filter((r) => r.value !== null)
    .map((r) => ({
      key: r.key,
      date: r.date,
      value: r.value!,
      source_url: r.source_url,
      fetched_at: r.fetched_at,
    }))
}

type RecipeSpec = Extract<
  SignalSpec,
  { signal: 'recipe-yoy-growth' | 'recipe-trailing-sum' | 'recipe-sum-of-keys' }
>

export async function readRecipeSignal(db: PipelineDb, spec: RecipeSpec): Promise<SignalReading[]> {
  switch (spec.signal) {
    case 'recipe-yoy-growth': {
      const own = yoyGrowth(await points(db, spec.recipe, [spec.key]))
      const rivals = await Promise.all(
        spec.compare_recipes.map(
          async (r) => [r, yoyGrowth(await points(db, r, [spec.key]))] as const,
        ),
      )
      return own.map((p) => ({
        date: p.date,
        value: p.value,
        detail: {
          value: p.base && (p.value + 1) * p.base.value,
          base_date: p.base.date,
          base_value: p.base.value,
          rivals: Object.fromEntries(
            rivals.map(([r, g]) => [
              RECIPES.find((x) => x.id === r)?.company ?? r,
              g.find((q) => Math.abs(dayOf(q.date) - dayOf(p.date)) <= 21)?.value ?? null,
            ]),
          ),
          compare: null,
        },
        source_url: p.source_url,
        fetched_at: p.fetched_at,
      }))
    }
    case 'recipe-trailing-sum':
      return trailingSum(await points(db, spec.recipe, [spec.key]), spec.days).map((p) => ({
        date: p.date,
        value: p.value,
        detail: { days: spec.days, compare: null },
        source_url: p.source_url,
        fetched_at: p.fetched_at,
      }))
    case 'recipe-sum-of-keys': {
      const byDate = new Map<string, (Point & { key: string })[]>()
      for (const p of await points(db, spec.recipe, spec.keys)) {
        byDate.set(p.date, [...(byDate.get(p.date) ?? []), p])
      }
      return [...byDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, ps]) => {
          const newest = ps.reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))
          return {
            date,
            value: ps.reduce((n, p) => n + p.value, 0),
            detail: { by_key: Object.fromEntries(ps.map((p) => [p.key, p.value])), compare: null },
            source_url: newest.source_url,
            fetched_at: newest.fetched_at,
          }
        })
    }
  }
}
