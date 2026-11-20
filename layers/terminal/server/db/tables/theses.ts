import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from './columns'

// Claim readings — one row per (claim, data date): the measured value a
// thesis claim is checked against (layers/terminal/server/theses). The newest date is
// rewritten while its data is still moving (OpenRouter revises trailing
// days); a reading whose inputs cannot be recomputed later — the spend
// premium joins today's list prices — is only ever written for the newest
// date, so a later price change never rewrites a past week.
export const claimReadings = sqliteTable(
  'claim_readings',
  {
    thesis_id: text('thesis_id').notNull(),
    claim_id: text('claim_id').notNull(),
    date: text('date').notNull(),
    value: real('value').notNull(),
    detail: text('detail').notNull(),
    computed_at: text('computed_at').notNull(),
    ...provenance,
  },
  (t) => [
    primaryKey({ columns: [t.claim_id, t.date] }),
    // terminalStamps() reads max(computed_at) on every cached request.
    index('claim_readings_computed_idx').on(t.computed_at),
  ],
)

// Claim status changes — append-only, one row each time a claim's computed
// status differs from its previous row. The thesis's revision trail and the
// weekly digest's input; the current status is the newest row per claim.
export const claimStatusChanges = sqliteTable(
  'claim_status_changes',
  {
    id: text('id').primaryKey(),
    thesis_id: text('thesis_id').notNull(),
    claim_id: text('claim_id').notNull(),
    status: text('status').notNull(), // holding | weakening | broken | unresolved
    previous_status: text('previous_status'),
    reading_date: text('reading_date'),
    reason: text('reason').notNull(),
    changed_at: text('changed_at').notNull(),
  },
  (t) => [index('claim_status_changes_claim_idx').on(t.claim_id, t.changed_at)],
)

// Claim verdicts — append-only, one per (claim, subject): the judge's rating
// of one candidate event for a judged thesis claim (layers/terminal/server/theses/verdicts.ts).
// subject is what the verdict is about — the change for a price cut, the
// incident's entity_key for an outage, so an incident updated twice is rated
// once. facts are what the Worker computed (a cut's size, an outage's hours);
// rationale is the judge's, grounded against the cited change and the facts.
export const claimVerdicts = sqliteTable(
  'claim_verdicts',
  {
    id: text('id').primaryKey(),
    thesis_id: text('thesis_id').notNull(),
    claim_id: text('claim_id').notNull(),
    subject: text('subject').notNull(),
    change_id: text('change_id').notNull(),
    provider: text('provider').notNull(),
    verdict: text('verdict').notNull(),
    rationale: text('rationale').notNull(),
    facts: text('facts').notNull(),
    detected_at: text('detected_at').notNull(),
    judged_at: text('judged_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('claim_verdicts_claim_idx').on(t.claim_id, t.detected_at),
    index('claim_verdicts_judged_idx').on(t.judged_at),
  ],
)

// Recipe observations — what a thesis recipe (layers/terminal/server/theses/recipes/) read
// from its source: one row per (recipe, key, date). A key is what the number
// is of (a revenue tag, a department, a package), the date what it is for (a
// quarter end, a day). Rewritten only when a re-read gives a different value
// or payload, so fetched_at says when this value was last read, and raw_key
// points at the stored bytes it was read from. Kept apart from `entities`:
// these companies are not the terminal's labs, and none of the lab
// panels, alert rules or the lab judge read this table.
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
    // about 5.9M rows a run, 63% of all D1 reads on 2026-11-07.
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
  (t) => [index('recipe_runs_recipe_idx').on(t.recipe_id, t.started_at)],
)

export type ClaimReading = typeof claimReadings.$inferSelect

export type ClaimStatusChange = typeof claimStatusChanges.$inferSelect

export type ClaimVerdict = typeof claimVerdicts.$inferSelect

export type RecipeObservation = typeof recipeObservations.$inferSelect

export type RecipeRun = typeof recipeRuns.$inferSelect
