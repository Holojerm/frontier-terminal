import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// The Frontier Terminal tables: the fetch pipeline's spine (snapshots, entities,
// changes, alerts, source and judge runs, the class map) and the thesis engine's
// (claim readings, status changes, verdicts, recipe observations and runs).
// NuxtHub merges every layer's server/db/schema.ts; the app's server/db/schema.ts
// re-exports this one so core's typed `db` and drizzle-kit see it. Migrations
// stay app-owned, in server/db/migrations. None of these tables references a
// core table, so no import from the app schema is needed.

// ─────────────────────────────────────────────
// Pipeline tables
// ─────────────────────────────────────────────
// These break the camelCase convention of the app's schema on purpose: the TypeScript keys
// ARE the zod contract's field names, so a validated contract row is the
// insert value with no mapping layer in between — one fewer place for a
// column to be renamed on one side only. Timestamps are ISO 8601 text with a
// timezone, exactly as the contracts carry them, not epoch integers: the
// stored string is the datum a reader is shown, and converting it twice is a
// chance to lose the offset.

// Every pipeline row a reader can see carries where it came from and when.
const provenance = {
  source_url: text('source_url').notNull(),
  fetched_at: text('fetched_at').notNull(),
}

// Snapshots — one row per fetch, the provenance spine. The raw bytes live in
// R2 under raw_key; an 'unchanged' fetch writes a row that points at the
// existing object, so the row count says how often a source was checked
// while the bucket only grows when content does.
export const snapshots = sqliteTable(
  'snapshots',
  {
    id: text('id').primaryKey(),
    source_id: text('source_id').notNull(),
    content_hash: text('content_hash').notNull(),
    raw_key: text('raw_key').notNull(),
    http_status: integer('http_status'),
    bytes: integer('bytes'),
    ...provenance,
  },
  (t) => [
    index('snapshots_source_fetched_idx').on(t.source_id, t.fetched_at),
    // (fetched_at, id) is the export's keyset order; without it every page
    // sorts the whole table.
    index('snapshots_fetched_id_idx').on(t.fetched_at, t.id),
  ],
)

// Entities — the CURRENT row per (source, entity_key). Rows are inserted when
// an entity appears, rewritten when its content hash changes, and deleted
// when a set-typed source (a job board, a pricing page) stops listing them.
// History lives in `changes`, never in duplicate entity rows.
//
// Storing every entity for every snapshot is the obvious alternative, and was
// measured at 130k rows in two weeks — almost all of them byte-identical
// repeats of the row before. The current set plus the
// change log carries the same information: any past state is the current
// state with the changes after that instant undone.
//
// snapshot_id is the snapshot whose parse produced the row's current
// content. An 'unchanged' fetch (same content hash) does not touch entities,
// so a source's freshness is read from its newest snapshot, not from here.
export const entities = sqliteTable(
  'entities',
  {
    source_id: text('source_id').notNull(),
    entity_key: text('entity_key').notNull(),
    entity_type: text('entity_type').notNull(),
    provider: text('provider').notNull(),
    content_hash: text('content_hash').notNull(),
    payload: text('payload').notNull(),
    snapshot_id: text('snapshot_id').notNull(),
    first_seen_at: text('first_seen_at').notNull(),
    ...provenance,
  },
  (t) => [
    primaryKey({ columns: [t.source_id, t.entity_key] }),
    index('entities_entity_key_idx').on(t.entity_key),
  ],
)

// Changes — append-only. id is contentHash(entity_key + before/after hashes)
// as layers/terminal/server/pipeline/diff.ts computes it, so the same two snapshots always
// yield the same ids and an overlapping tick cannot log a change twice.
export const changes = sqliteTable(
  'changes',
  {
    id: text('id').primaryKey(),
    entity_key: text('entity_key').notNull(),
    entity_type: text('entity_type').notNull(),
    provider: text('provider').notNull(),
    change_type: text('change_type').notNull(),
    before_hash: text('before_hash'),
    after_hash: text('after_hash'),
    before_json: text('before_json'),
    after_json: text('after_json'),
    detected_at: text('detected_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('changes_detected_id_idx').on(t.detected_at, t.id),
    index('changes_entity_key_idx').on(t.entity_key),
  ],
)

// Alerts — append-only. change_ids is a JSON array of changes.id; the
// explanation may cite only fields present in those rows.
export const alerts = sqliteTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    severity: text('severity').notNull(),
    headline: text('headline').notNull(),
    explanation: text('explanation').notNull(),
    change_ids: text('change_ids').notNull(),
    rule: text('rule').notNull(),
    created_at: text('created_at').notNull(),
    ...provenance,
  },
  (t) => [index('alerts_created_id_idx').on(t.created_at, t.id)],
)

// Source runs — one row per (tick, source): what each poll attempted and how
// it ended. Powers the coverage panel and the failure alerts, and is what
// refresh reads to find a source's last GOOD snapshot — a run row is written
// after the entity writes, so a tick that died halfway leaves no run row and
// the next tick re-parses instead of trusting a half-applied snapshot.
export const sourceRuns = sqliteTable(
  'source_runs',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    source_id: text('source_id').notNull(),
    started_at: text('started_at').notNull(),
    status: text('status').notNull(), // ok | unchanged | failed | baseline
    detail: text('detail'),
    snapshot_id: text('snapshot_id'),
    added: integer('added').notNull(),
    removed: integer('removed').notNull(),
    modified: integer('modified').notNull(),
    source_url: text('source_url').notNull(),
  },
  (t) => [
    index('source_runs_source_started_idx').on(t.source_id, t.started_at),
    index('source_runs_started_id_idx').on(t.started_at, t.id),
    // Baseline runs are a handful among tens of thousands; this finds them
    // without scanning the rest.
    index('source_runs_status_source_idx').on(t.status, t.source_id, t.started_at),
  ],
)

// Source stats — one row per source: how many snapshots and runs it has, and
// the first and newest of each. snapshots and source_runs grow by a row per
// source per tick forever, so any per-source aggregate over them reads every
// row ever written; this table answers the same questions in one row per
// source. insertRows() keeps it in step, in the same batch as the row it
// counts, so nothing else writes snapshots or runs without it.
export const sourceStats = sqliteTable('source_stats', {
  source_id: text('source_id').primaryKey(),
  snapshot_count: integer('snapshot_count').notNull().default(0),
  first_fetched_at: text('first_fetched_at'),
  last_fetched_at: text('last_fetched_at'),
  run_count: integer('run_count').notNull().default(0),
  last_run_at: text('last_run_at'),
})

// Judge runs — one row per POST /api/judge/alerts (layers/terminal/server/pipeline/judge).
// judged_through is the cursor GET /api/judge/pending reads: a change is
// pending while its detected_at is newer than the newest judged_through
// here. NULL when the run advanced nothing — a body that failed the schema
// gate is recorded (rejection_reason says why) without moving the cursor,
// so the changes it was about are offered again next hour.
export const judgeRuns = sqliteTable(
  'judge_runs',
  {
    id: text('id').primaryKey(),
    started_at: text('started_at').notNull(),
    judged_through: text('judged_through'),
    changes_seen: integer('changes_seen').notNull(),
    accepted: integer('accepted').notNull(),
    rejected: integer('rejected').notNull(),
    rejection_reason: text('rejection_reason'),
    source: text('source').notNull(), // 'routine' today; anything else that judges says who
  },
  (t) => [
    index('judge_runs_started_at_idx').on(t.started_at),
    index('judge_runs_judged_through_idx').on(t.judged_through),
  ],
)

// Class-map decisions — append-only. One row per mapping the judge changed on
// the like-for-like price matrix (layers/terminal/server/pipeline/judge/class-map.ts). The
// hand-transcribed MODEL_CLASS_MAP (layers/terminal/server/utils/terminal-classes.ts) is the
// seed; the newest row per (provider, class) overrides it. A row is written
// only after the Worker proved the sentence is on the vendor page, so its
// provenance is the snapshot that sentence was verified in, not the judge.
export const classMapDecisions = sqliteTable(
  'class_map_decisions',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    class: text('class').notNull(),
    model_slug: text('model_slug').notNull(),
    basis: text('basis').notNull(),
    basis_source_id: text('basis_source_id').notNull(),
    decided_at: text('decided_at').notNull(),
    decided_by: text('decided_by').notNull(), // 'judge' today; anything else that decides says who
    ...provenance,
  },
  (t) => [index('class_map_decisions_cell_idx').on(t.provider, t.class, t.decided_at)],
)

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
  (t) => [primaryKey({ columns: [t.claim_id, t.date] })],
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
  (t) => [index('claim_verdicts_claim_idx').on(t.claim_id, t.detected_at)],
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
  (t) => [index('recipe_observations_recipe_idx').on(t.recipe_id, t.key, t.date)],
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

// Filed facts — append-only. One row per XBRL fact a public filer reported in
// one filing: (ticker, concept, dimensions, period, accession). A restatement
// arrives under a later accession as its own row, so the value it replaced
// stays readable as superseded. Read from company facts (non-dimensional
// facts) and from each 10-Q/10-K's own instance (the dimensional ones company
// facts drops) by layers/terminal/server/exposure/ingest.ts. `filed` is the
// filing's date, so a read as of T keeps the rows filed before T's day.
export const filedFacts = sqliteTable(
  'filed_facts',
  {
    id: text('id').primaryKey(),
    ticker: text('ticker').notNull(),
    cik: text('cik').notNull(),
    concept: text('concept').notNull(),
    dims: text('dims').notNull(), // '' when the context names no dimension
    start: text('start'), // null for a balance (an instant)
    end: text('end').notNull(),
    value: real('value').notNull(),
    unit: text('unit').notNull(),
    form: text('form').notNull(),
    filed: text('filed').notNull(),
    accession_no: text('accession_no').notNull(),
    basis: text('basis').notNull(), // companyfacts | instance
    raw_key: text('raw_key').notNull(),
    first_seen_at: text('first_seen_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('filed_facts_series_idx').on(t.ticker, t.concept, t.end),
    index('filed_facts_filed_idx').on(t.filed, t.id),
  ],
)

// Filed-fact reads — one row per document fetch: a filer's company facts, or
// one filing's instance. An instance read `ok` is never fetched again (a
// filing never changes once accepted); company facts are re-read on a
// schedule and skipped when their hash has not moved.
export const filedFactReads = sqliteTable(
  'filed_fact_reads',
  {
    id: text('id').primaryKey(),
    ticker: text('ticker').notNull(),
    kind: text('kind').notNull(), // companyfacts | instance
    accession_no: text('accession_no'), // null for company facts
    status: text('status').notNull(), // ok | unchanged | failed
    detail: text('detail'),
    content_hash: text('content_hash'),
    facts: integer('facts').notNull(),
    started_at: text('started_at').notNull(),
    source_url: text('source_url').notNull(),
  },
  (t) => [index('filed_fact_reads_doc_idx').on(t.ticker, t.kind, t.started_at)],
)

export type Snapshot = typeof snapshots.$inferSelect
export type Entity = typeof entities.$inferSelect
export type Change = typeof changes.$inferSelect
export type Alert = typeof alerts.$inferSelect
export type SourceRun = typeof sourceRuns.$inferSelect
export type JudgeRun = typeof judgeRuns.$inferSelect
export type ClassMapDecision = typeof classMapDecisions.$inferSelect
export type ClaimReading = typeof claimReadings.$inferSelect
export type ClaimStatusChange = typeof claimStatusChanges.$inferSelect
export type ClaimVerdict = typeof claimVerdicts.$inferSelect
export type RecipeObservation = typeof recipeObservations.$inferSelect
export type RecipeRun = typeof recipeRuns.$inferSelect
export type FiledFact = typeof filedFacts.$inferSelect
export type FiledFactRead = typeof filedFactReads.$inferSelect
