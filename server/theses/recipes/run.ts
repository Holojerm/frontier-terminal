// Run every recipe once: fetch through the pipeline's own fetcher (retries,
// the SEC contact header, the body cap), keep the raw bytes in R2 when they
// changed, extract, and upsert what changed into recipe_observations. Runs on
// the survey tick before the theses are evaluated, so readings see this
// tick's data. One recipe failing never stops the others.

import { and, desc, eq, max, sql } from 'drizzle-orm'

import * as tables from '../../db/schema'
import { contentHash, contentHashOfText } from '../../pipeline/contracts'
import type { SourceFetcher } from '../../pipeline/fetch'
import type { RawStore } from '../../pipeline/refresh'
import { chunk, D1_MAX_BOUND_PARAMS, type PipelineDb } from '../../pipeline/store'
import { recordOpsEvent } from '../../utils/ops'
import type { Recipe } from './contract'
import { RECIPES } from './registry'

const OBSERVATION_COLUMNS = 11

export interface RecipeRunResult {
  recipe_id: string
  status: 'ok' | 'unchanged' | 'failed'
  detail: string | null
  observations: number
}

async function newestDate(db: PipelineDb, recipeId: string): Promise<string | null> {
  const [row] = await db
    .select({ at: max(tables.recipeObservations.date) })
    .from(tables.recipeObservations)
    .where(eq(tables.recipeObservations.recipe_id, recipeId))
  return row?.at ?? null
}

async function lastHash(db: PipelineDb, recipeId: string): Promise<string | null> {
  const [row] = await db
    .select({ hash: tables.recipeRuns.content_hash })
    .from(tables.recipeRuns)
    .where(
      and(
        eq(tables.recipeRuns.recipe_id, recipeId),
        sql`${tables.recipeRuns.content_hash} is not null`,
      ),
    )
    .orderBy(desc(tables.recipeRuns.started_at))
    .limit(1)
  return row?.hash ?? null
}

async function runOne(
  db: PipelineDb,
  recipe: Recipe,
  deps: { raw: RawStore; fetcher: SourceFetcher; now: Date },
): Promise<RecipeRunResult & { url: string; hash: string | null }> {
  const url = recipe.url({ now: deps.now, newest: await newestDate(db, recipe.id) })
  const fetched = await deps.fetcher({ source_id: recipe.id, url, ext: recipe.ext })
  if (!fetched.ok) {
    return {
      recipe_id: recipe.id,
      status: 'failed',
      detail: fetched.detail,
      observations: 0,
      url,
      hash: null,
    }
  }
  const fetched_at = deps.now.toISOString()
  const hash = contentHashOfText(fetched.text)
  const raw_key = `recipes/${recipe.id}/${hash}.${recipe.ext}`
  if (hash === (await lastHash(db, recipe.id))) {
    return { recipe_id: recipe.id, status: 'unchanged', detail: null, observations: 0, url, hash }
  }
  let observations
  try {
    observations = recipe.extract(fetched.text, { date: fetched_at.slice(0, 10) })
  } catch (error) {
    return {
      recipe_id: recipe.id,
      status: 'failed',
      detail: `extract: ${String(error)}`,
      observations: 0,
      url,
      hash: null,
    }
  }
  if (observations.length === 0) {
    return {
      recipe_id: recipe.id,
      status: 'failed',
      detail: 'extract returned no observations',
      observations: 0,
      url,
      hash: null,
    }
  }
  await deps.raw.put(
    raw_key,
    fetched.text,
    recipe.ext === 'json' ? 'application/json' : 'text/plain',
  )
  const rows = observations.map((o) => ({
    id: contentHash({ recipe: recipe.id, key: o.key, date: o.date }),
    recipe_id: recipe.id,
    company: recipe.company,
    key: o.key,
    date: o.date,
    value: o.value,
    payload: JSON.stringify(o.payload),
    raw_key,
    first_seen_at: fetched_at,
    source_url: url,
    fetched_at,
  }))
  for (const part of chunk(rows, Math.floor(D1_MAX_BOUND_PARAMS / OBSERVATION_COLUMNS))) {
    await db
      .insert(tables.recipeObservations)
      .values(part)
      .onConflictDoUpdate({
        target: tables.recipeObservations.id,
        set: {
          value: sql`excluded.value`,
          payload: sql`excluded.payload`,
          raw_key: sql`excluded.raw_key`,
          source_url: sql`excluded.source_url`,
          fetched_at: sql`excluded.fetched_at`,
        },
        setWhere: sql`excluded.value is not ${tables.recipeObservations.value} or excluded.payload != ${tables.recipeObservations.payload}`,
      })
  }
  return { recipe_id: recipe.id, status: 'ok', detail: null, observations: rows.length, url, hash }
}

export async function runRecipes(
  db: PipelineDb,
  deps: { raw: RawStore; fetcher: SourceFetcher; now: () => Date },
  recipes: readonly Recipe[] = RECIPES,
): Promise<RecipeRunResult[]> {
  const results: RecipeRunResult[] = []
  for (const recipe of recipes) {
    const started_at = deps.now()
    const r = await runOne(db, recipe, { ...deps, now: started_at }).catch((error: unknown) => ({
      recipe_id: recipe.id,
      status: 'failed' as const,
      detail: String(error),
      observations: 0,
      url: '',
      hash: null,
    }))
    await db.insert(tables.recipeRuns).values({
      id: crypto.randomUUID(),
      recipe_id: recipe.id,
      started_at: started_at.toISOString(),
      status: r.status,
      detail: r.detail?.slice(0, 500) ?? null,
      content_hash: r.hash,
      observations: r.observations,
      source_url: r.url,
    })
    if (r.status === 'failed') {
      await recordOpsEvent(db, { kind: 'recipe_failed', detail: `${recipe.id}: ${r.detail}` })
    }
    results.push({
      recipe_id: r.recipe_id,
      status: r.status,
      detail: r.detail,
      observations: r.observations,
    })
  }
  return results
}
