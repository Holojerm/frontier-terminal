// Run every recipe once: fetch through the pipeline's own fetcher (retries,
// the SEC contact header, the body cap), keep the raw bytes in R2 when they
// changed, extract, and upsert what changed into recipe_observations. Runs on
// the survey tick before the theses are evaluated, so readings see this
// tick's data. One recipe failing never stops the others.

import { and, desc, eq, lt, max, min, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { contentHash, contentHashOfText } from '#layers/core/server/utils/contracts'
import type { SourceFetcher } from '#layers/core/server/utils/pipeline-fetch'
import {
  isRateLimitRun,
  rateLimitAlertDue,
  RECIPE_RATE_LIMIT_ALERT_AFTER_MS,
} from '#layers/core/server/pipeline/rate-limit'
import type { RawStore } from '#layers/core/server/utils/pipeline-raw'
import {
  chunk,
  D1_MAX_BOUND_PARAMS,
  type PipelineDb,
} from '#layers/core/server/utils/pipeline-store'
import { recordOpsEvent } from '#server/utils/ops'
import type { Observation, Recipe } from '#layers/core/server/recipes/contract'
import { RECIPES } from '#server/registries/recipes'

const OBSERVATION_COLUMNS = 11

interface RecipeRunResult {
  recipe_id: string
  /** skipped: the source needs a secret this deploy does not have; nothing was fetched. */
  status: 'ok' | 'unchanged' | 'failed' | 'skipped'
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
  const newest = await newestDate(db, recipe.id)
  let url = recipe.url({ now: deps.now, newest })
  let fetched = await deps.fetcher({ source_id: recipe.id, url, ext: recipe.ext })
  if (fetched.ok && recipe.follow) {
    try {
      url = recipe.follow(fetched.text, { newest })
    } catch (error) {
      return {
        recipe_id: recipe.id,
        status: 'failed',
        detail: `follow: ${String(error)}`,
        observations: 0,
        url,
        hash: null,
      }
    }
    fetched = await deps.fetcher({ source_id: recipe.id, url, ext: recipe.ext })
  }
  if (!fetched.ok) {
    return {
      recipe_id: recipe.id,
      status: 'skipped' in fetched ? 'skipped' : 'failed',
      detail: fetched.detail,
      observations: 0,
      url,
      hash: null,
    }
  }
  const fetched_at = deps.now.toISOString()
  let hash: string
  try {
    const judged = recipe.fingerprint?.(fetched.text) ?? fetched.text
    hash = contentHashOfText(recipe.revision ? `${judged}\nrevision:${recipe.revision}` : judged)
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
  await deps.raw.put(raw_key, fetched.text, contentType(recipe))
  const stored = await storeObservations(db, recipe, observations, { raw_key, url, fetched_at })
  return { recipe_id: recipe.id, status: 'ok', detail: null, observations: stored, url, hash }
}

const contentType = (recipe: Recipe) =>
  recipe.ext === 'json'
    ? 'application/json'
    : recipe.ext === 'xml'
      ? 'application/xml'
      : 'text/plain'

async function storeObservations(
  db: PipelineDb,
  recipe: Recipe,
  observations: readonly Observation[],
  at: { raw_key: string; url: string; fetched_at: string; retrospective?: boolean },
): Promise<number> {
  const rows = observations.map((o) => ({
    id: contentHash({ recipe: recipe.id, key: o.key, date: o.date }),
    recipe_id: recipe.id,
    company: recipe.company,
    key: o.key,
    date: o.date,
    value: o.value,
    payload: JSON.stringify(at.retrospective ? { ...o.payload, retrospective: true } : o.payload),
    raw_key: at.raw_key,
    first_seen_at: at.fetched_at,
    source_url: at.url,
    fetched_at: at.fetched_at,
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
  return rows.length
}

async function oldestDate(db: PipelineDb, recipeId: string): Promise<string | null> {
  const [row] = await db
    .select({ at: min(tables.recipeObservations.date) })
    .from(tables.recipeObservations)
    .where(eq(tables.recipeObservations.recipe_id, recipeId))
  return row?.at ?? null
}

/**
 * The past runs a recipe asks for, after its own run read its source. There
 * is no hash check: two past days can return the same bytes (a zero count)
 * and both are new. Nothing here writes a run row, so the next run's
 * unchanged check still compares against the last live body. Rows are stored
 * as of now, retrospective, and stop at the first failure.
 */
async function runBackfill(
  db: PipelineDb,
  recipe: Recipe,
  deps: { raw: RawStore; fetcher: SourceFetcher; now: Date },
): Promise<{ observations: number; failure: string | null; rateLimited: boolean }> {
  let observations = 0
  if (!recipe.backfill) return { observations, failure: null, rateLimited: false }
  const fetched_at = deps.now.toISOString()
  for (const run of recipe.backfill({ oldest: await oldestDate(db, recipe.id) })) {
    // The run date, as the recipe's own run would have had it.
    const stop = (why: string, rateLimited = false) => ({
      observations,
      failure: `backfill as of ${run.date}: ${why}`,
      rateLimited,
    })
    const fetched = await deps.fetcher({ source_id: recipe.id, url: run.url, ext: recipe.ext })
    if (!fetched.ok)
      return stop(fetched.detail, isRateLimitRun({ status: 'failed', detail: fetched.detail }))
    let found: Observation[]
    try {
      found = recipe.extract(fetched.text, { date: run.date })
    } catch (error) {
      return stop(`extract: ${String(error)}`)
    }
    if (found.length === 0) return stop('extract returned no observations')
    const raw_key = `recipes/${recipe.id}/${contentHashOfText(fetched.text)}.${recipe.ext}`
    await deps.raw.put(raw_key, fetched.text, contentType(recipe))
    observations += await storeObservations(db, recipe, found, {
      raw_key,
      url: run.url,
      fetched_at,
      retrospective: run.retrospective ?? true,
    })
  }
  return { observations, failure: null, rateLimited: false }
}

// A 429 follows the sources' policy (pipeline/rate-limit.ts), with the streak
// measured in survey ticks: npm's API sheds load for a tick or two now and
// then, and a short run of 429s is not worth a page.
async function failureAlertDue(
  db: PipelineDb,
  recipeId: string,
  run: { status: string; detail: string | null },
  startedAt: Date,
): Promise<boolean> {
  if (!isRateLimitRun(run)) return true
  const history = await db
    .select({
      status: tables.recipeRuns.status,
      detail: tables.recipeRuns.detail,
      started_at: tables.recipeRuns.started_at,
    })
    .from(tables.recipeRuns)
    .where(
      and(
        eq(tables.recipeRuns.recipe_id, recipeId),
        lt(tables.recipeRuns.started_at, startedAt.toISOString()),
      ),
    )
    .orderBy(desc(tables.recipeRuns.started_at))
    .limit(50)
  return rateLimitAlertDue(history, startedAt.getTime(), RECIPE_RATE_LIMIT_ALERT_AFTER_MS)
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
    // Only after the source answered its own run: a failed or unconfigured
    // source would fail every past day the same way.
    if (r.status === 'ok' || r.status === 'unchanged') {
      const past = await runBackfill(db, recipe, { ...deps, now: started_at }).catch(
        (error: unknown) => ({
          observations: 0,
          failure: `backfill: ${String(error)}`,
          rateLimited: false,
        }),
      )
      r.observations += past.observations
      if (past.failure) {
        r.detail = past.failure
        // A 429 is retried by the next tick's walk; anything else is a fault.
        if (!past.rateLimited)
          await recordOpsEvent(db, {
            kind: 'recipe_failed',
            detail: `${recipe.id}: ${past.failure}`,
          })
      }
    }
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
    if (r.status === 'failed' && (await failureAlertDue(db, recipe.id, r, started_at))) {
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
