import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from './columns'

// Recipe observations: what a thesis recipe read, one row per (recipe, key,
// date), the key what the number is of and the date what it is for. Rewritten
// only when a re-read differs, so fetched_at is the last read. Kept apart from
// `entities` (these are not the terminal's labs); the lab panels and judge
// never read it, but the GPU median rule does
// (layers/compute/server/pipeline/gpu-median-floor.ts).
export const recipeObservations = sqliteTable(
  'recipe_observations',
  {
    id: text('id').primaryKey(),
    recipe_id: text('recipe_id').notNull(),
    company: text('company').notNull(),
    key: text('key').notNull(),
    date: text('date').notNull(),
    value: real('value'),
    payload: text('payload').notNull(),
    raw_key: text('raw_key').notNull(),
    first_seen_at: text('first_seen_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('recipe_observations_recipe_idx').on(t.recipe_id, t.key, t.date),
    // recipeCoverage() finds each recipe's newest fetch. Without this it read
    // about 5.9M rows a run, 63% of all D1 reads.
    index('recipe_observations_fetched_idx').on(t.recipe_id, t.fetched_at),
  ],
)

// Recipe runs — one row per (survey tick, recipe): what was fetched and how
// it ended. A failed run is flagged here and spooled as an ops event, never
// skipped silently; content_hash lets the next run skip re-storing bytes it
// already holds.
export const recipeRuns = sqliteTable(
  'recipe_runs',
  {
    id: text('id').primaryKey(),
    recipe_id: text('recipe_id').notNull(),
    started_at: text('started_at').notNull(),
    status: text('status').notNull(), // ok | unchanged | failed | skipped
    detail: text('detail'),
    content_hash: text('content_hash'),
    observations: integer('observations').notNull(),
    source_url: text('source_url').notNull(),
  },
  (t) => [
    index('recipe_runs_recipe_idx').on(t.recipe_id, t.started_at),
    // The newest run of any recipe is the coverage route's cache variant, read
    // on every request. Without this it scanned the table (4k rows, 700 a day).
    index('recipe_runs_started_idx').on(t.started_at),
  ],
)

export type RecipeObservation = typeof recipeObservations.$inferSelect

export type RecipeRun = typeof recipeRuns.$inferSelect
