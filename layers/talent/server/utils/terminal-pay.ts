// The read side of the posted-pay recipes (recipes/pay-bands.ts): the newest
// reading of each lab's posted US salary bands per department cell, against
// the reading before. Every figure keeps the URL it was read from and when; a
// recipe with no stored rows yet yields no board, never a guess.

import { inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { companyName, type CompanyId } from '#layers/core/shared/utils/companies'
import type { LabId, RecipeCitation } from '#layers/core/shared/utils/terminal-types/common'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { PROVIDER_ORDER } from '#layers/core/server/utils/terminal-sources'
import type { PayCell, PayData } from '../../shared/utils/pay'
import { PAY_RECIPES } from '../recipes/pay-bands'

type Row = typeof tables.recipeObservations.$inferSelect

/** Every recipe the pay view reads, for the cache key. */
export const PAY_RECIPE_IDS = PAY_RECIPES.map((r) => r.id)

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

export const PAY_CAVEAT =
  'The median midpoint of each posted US annual salary band. Bands are posted ranges, not offers, and leave out equity, which is the larger part of pay at these labs. We map departments by hand for each board and leave out sales (Anthropic posts on-target earnings, OpenAI base pay). So compare each cell with itself over time instead of comparing labs. xAI and Mistral post no usable pay.'

const PAY_LABELS: Record<string, string> = {
  all: 'All roles',
  research: 'Research',
  swe: 'Software engineering',
}

export async function queryPay(db: PipelineDb): Promise<PayData> {
  const rows = await rowsOf(
    db,
    PAY_RECIPES.map((r) => r.id),
  )
  const boards = PAY_RECIPES.flatMap((recipe) => {
    if (!isLab(recipe.company)) return []
    const rs = rows.filter((r) => r.recipe_id === recipe.id && r.value !== null)
    const dates = [...new Set(rs.map((r) => r.date))].sort()
    const date = dates.at(-1)
    if (!date) return []
    const previous = dates.at(-2) ?? null
    const now = rs.filter((r) => r.date === date)
    const cells: PayCell[] = now.map((r) => {
      const p = payloadOf(r) as {
        n: number
        p25: number
        p75: number
        departments: string[] | null
      }
      const prev = previous ? rs.find((x) => x.date === previous && x.key === r.key) : undefined
      return {
        key: r.key,
        label: PAY_LABELS[r.key] ?? r.key,
        median: r.value!,
        p25: p.p25,
        p75: p.p75,
        n: p.n,
        departments: p.departments,
        previous: prev ? { date: prev.date, median: prev.value! } : null,
      }
    })
    const roles = (payloadOf(now[0]!) as { roles_on_board?: number }).roles_on_board ?? 0
    return [
      {
        recipe_id: recipe.id,
        lab: recipe.company,
        date,
        roles_on_board: roles,
        cells: cells.sort(
          (a, b) => Object.keys(PAY_LABELS).indexOf(a.key) - Object.keys(PAY_LABELS).indexOf(b.key),
        ),
        source: cite(recipe.id, `${companyName(recipe.company)} job board`, newestRow(now)!),
      },
    ]
  })
  return { as_of: asOf(rows), boards, caveat: PAY_CAVEAT }
}
