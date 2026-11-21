// The read side of the rate-limit recipes (recipes/rate-limits.ts): the
// newest snapshot of each lab's published limits, what changed since the one
// before, and the Internet Archive copies of the same page. Every figure keeps
// the URL it was read from and when; a recipe with no stored rows yet yields
// no page, never a guess.

import { inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { companyName, type CompanyId } from '#layers/core/shared/utils/companies'
import type { LabId, RecipeCitation } from '#layers/core/shared/types/common'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { PROVIDER_ORDER } from '#layers/core/server/utils/terminal-sources'
import type { LimitRow, LimitsData } from '../../shared/utils/limits'
import { RATE_LIMIT_RECIPES } from '../recipes/rate-limits'
import { archivedLimitChanges, archivedLimitCopies } from './terminal-price-archive'

type Row = typeof tables.recipeObservations.$inferSelect

/** Every recipe the limits view reads, for the cache key. */
export const LIMIT_RECIPE_IDS = RATE_LIMIT_RECIPES.map((r) => r.id)

const isLab = (c: CompanyId): c is LabId => (PROVIDER_ORDER as readonly string[]).includes(c)

async function rowsOf(db: PipelineDb, ids: readonly string[]): Promise<Row[]> {
  if (ids.length === 0) return []
  return db
    .select()
    .from(tables.recipeObservations)
    .where(inArray(tables.recipeObservations.recipe_id, [...ids]))
}

const payloadOf = (r: Row): Record<string, unknown> =>
  JSON.parse(r.payload) as Record<string, unknown>

function newestRow(rows: readonly Row[]): Row | null {
  return rows.reduce<Row | null>((a, b) => (!a || b.fetched_at > a.fetched_at ? b : a), null)
}

function cite(recipe_id: string, label: string, r: Row): RecipeCitation {
  return { recipe_id, label, source_url: r.source_url, fetched_at: r.fetched_at }
}

const asOf = (rows: readonly Row[]) => newestRow(rows)?.fetched_at ?? null

export const LIMITS_CAVEAT =
  'The limits each lab publishes in its docs. They reflect tier design and abuse control as much as capacity, and they change in announced steps. We store a new reading only when a limit changes. Google and Mistral publish no per-model limits. Anthropic’s history before our first read is from Internet Archive copies of the same page.'

function snapshotRows(rows: readonly Row[]): { metrics: string[]; rows: LimitRow[] } {
  const metrics: string[] = []
  const grouped = new Map<string, LimitRow>()
  for (const r of rows) {
    const p = payloadOf(r) as { model?: string; tier?: string; metric?: string; text?: string }
    const model = p.model ?? r.key.split('|')[0]!
    const tier = p.tier ?? r.key.split('|')[1]!
    const metric = p.metric ?? r.key.split('|')[2]!
    const id = `${model}|${tier}`
    const row = grouped.get(id) ?? { model, tier, values: {}, text: null }
    if (metric === 'other') row.text = p.text ?? null
    else {
      if (!metrics.includes(metric)) metrics.push(metric)
      row.values[metric] = r.value
    }
    grouped.set(id, row)
  }
  return { metrics, rows: [...grouped.values()] }
}

export async function queryLimits(db: PipelineDb): Promise<LimitsData> {
  const [rows, copies, changes] = await Promise.all([
    rowsOf(
      db,
      RATE_LIMIT_RECIPES.map((r) => r.id),
    ),
    archivedLimitCopies(db),
    archivedLimitChanges(db),
  ])
  const archivedOf = (recipe_id: string) => {
    const own = copies.filter((c) => c.recipe_id === recipe_id)
    if (own.length === 0) return null
    return {
      copies: own.length,
      from: own[0]!.captured_at,
      to: own.at(-1)!.captured_at,
      changes: changes
        .filter((c) => c.recipe_id === recipe_id)
        .map((c) => ({
          model: c.model,
          tier: c.tier,
          metric: c.metric,
          before: c.before,
          after: c.after,
          window_from: c.window_from,
          window_to: c.window_to,
          source_url: c.source_url,
        })),
    }
  }
  const pages = RATE_LIMIT_RECIPES.flatMap((recipe) => {
    if (!isLab(recipe.company)) return []
    const rs = rows.filter((r) => r.recipe_id === recipe.id)
    const dates = [...new Set(rs.map((r) => r.date))].sort()
    const snapshot = dates.at(-1)
    if (!snapshot) return []
    const now = rs.filter((r) => r.date === snapshot)
    const previous = dates.at(-2) ?? null
    const before = new Map(rs.filter((r) => r.date === previous).map((r) => [r.key, r.value]))
    const changed = previous ? now.filter((r) => before.get(r.key) !== r.value).length : 0
    return [
      {
        recipe_id: recipe.id,
        lab: recipe.company,
        covers: recipe.description.replace(/^Published API rate limits: /, ''),
        ...snapshotRows(now),
        snapshot,
        previous,
        changed,
        source: cite(recipe.id, `${companyName(recipe.company)} rate limits`, newestRow(now)!),
        archived: archivedOf(recipe.id),
      },
    ]
  })
  return { as_of: asOf(rows), pages, caveat: LIMITS_CAVEAT }
}
