import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

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
    // When the row was written. created_at is the evidence's fetch time, which
    // for a judged alert is up to an hour or more earlier; a hold measured
    // from it was mostly spent before the alert existed. Stamped by the
    // alerts_recorded_at trigger (migration), so no writer has to set it;
    // rows from before the column read created_at.
    recorded_at: text('recorded_at'),
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
  (t) => [
    primaryKey({ columns: [t.claim_id, t.date] }),
    // thesesStamp() reads max(computed_at) on every /api/theses request.
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
  (t) => [
    index('filed_fact_reads_doc_idx').on(t.ticker, t.kind, t.started_at),
    // filedFactsStamp() reads max(started_at) across every ticker; the doc index can't serve it.
    index('filed_fact_reads_started_idx').on(t.started_at),
  ],
)

// ─────────────────────────────────────────────
// Track record tables (layers/terminal/server/pipeline/track-record/)
// ─────────────────────────────────────────────
// For each material alert: when the terminal saw the change, against when the
// press (GDELT) and the lab's own newsroom first carried it. All three are
// append-only, so the track-record tab and its exports answer as_of by the
// column that says when each row was written.

// One row per search for an alert's candidates: a GDELT query, or a read of
// the stored newsroom posts. A failed GDELT search is kept (the page says so)
// and retried; an ok one is never repeated.
export const trackRecordSearches = sqliteTable(
  'track_record_searches',
  {
    id: text('id').primaryKey(),
    alert_id: text('alert_id').notNull(),
    source: text('source').notNull(), // gdelt | newsroom
    query: text('query').notNull(),
    window_start: text('window_start').notNull(),
    window_end: text('window_end').notNull(),
    status: text('status').notNull(), // ok | failed | skipped
    detail: text('detail'),
    candidates: integer('candidates').notNull(),
    searched_at: text('searched_at').notNull(),
    raw_key: text('raw_key'),
    source_url: text('source_url').notNull(),
  },
  (t) => [index('track_record_searches_alert_idx').on(t.alert_id, t.source, t.searched_at)],
)

// One row per GDELT GKG file the press side has read (pipeline/track-record/gkg.ts):
// its quarter hour, how it ended, and where the rows that matched an alert
// are kept. A file is read once; its matches are press candidates whose
// search_id is `gkg:<stamp>`. missing: GDELT never published that quarter hour.
export const gdeltFiles = sqliteTable(
  'gdelt_files',
  {
    stamp: text('stamp').primaryKey(),
    url: text('url').notNull(),
    status: text('status').notNull(), // ok | missing
    rows: integer('rows').notNull(),
    matched: integer('matched').notNull(),
    raw_key: text('raw_key'),
    fetched_at: text('fetched_at').notNull(),
    recorded_at: text('recorded_at').notNull(),
  },
  (t) => [index('gdelt_files_recorded_idx').on(t.recorded_at)],
)

// One row per (alert, kind, url): an article or newsroom post inside the
// alert's window that matched its search terms. A candidate is not a match;
// a match is a same-event verdict below.
export const trackRecordCandidates = sqliteTable(
  'track_record_candidates',
  {
    id: text('id').primaryKey(),
    alert_id: text('alert_id').notNull(),
    kind: text('kind').notNull(), // press | newsroom
    title: text('title').notNull(),
    snippet: text('snippet'),
    outlet: text('outlet').notNull(),
    url: text('url').notNull(),
    published_at: text('published_at').notNull(),
    search_id: text('search_id').notNull(),
    found_at: text('found_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('track_record_candidates_alert_idx').on(t.alert_id, t.kind, t.published_at),
    index('track_record_candidates_found_idx').on(t.found_at, t.id),
  ],
)

// One verdict per candidate: the judge routine's same-event rating, gated
// and grounded by the Worker (track-record/review.ts).
export const trackRecordVerdicts = sqliteTable(
  'track_record_verdicts',
  {
    id: text('id').primaryKey(),
    candidate_id: text('candidate_id').notNull(),
    alert_id: text('alert_id').notNull(),
    same_event: integer('same_event', { mode: 'boolean' }).notNull(),
    rationale: text('rationale').notNull(),
    judged_at: text('judged_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('track_record_verdicts_alert_idx').on(t.alert_id),
    index('track_record_verdicts_judged_idx').on(t.judged_at, t.id),
  ],
)

// Licensee API keys, issued by the owner with `bun run keys:issue`. Only the
// SHA-256 of a key is stored, so a leaked table grants nothing. Never exported,
// never served: layers/terminal/server/utils/api-keys.ts reads it by hash.
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    key_hash: text('key_hash').notNull(),
    client: text('client').notNull(),
    tier: text('tier').notNull(), // research | systematic
    issued_at: text('issued_at').notNull(),
    expires_at: text('expires_at').notNull(),
    revoked: integer('revoked', { mode: 'boolean' }).notNull().default(false),
    revoked_at: text('revoked_at'),
  },
  (t) => [uniqueIndex('api_keys_hash_idx').on(t.key_hash)],
)

// S3 read access to the licensed bulk bucket, granted by the owner with
// `bun run bulk:grant`. Each grant is one Cloudflare API token, read-only and
// scoped to that bucket, expiring with the key it was granted to. token_id is
// the token's id, which is also the S3 access key id; the secret is shown once
// and never stored. Never exported, never served.
export const bulkGrants = sqliteTable(
  'bulk_grants',
  {
    id: text('id').primaryKey(),
    api_key_id: text('api_key_id').notNull(),
    token_id: text('token_id').notNull(),
    bucket: text('bucket').notNull(),
    created_at: text('created_at').notNull(),
    expires_at: text('expires_at').notNull(),
    revoked_at: text('revoked_at'),
    revoke_reason: text('revoke_reason'), // owner | key-revoked | key-expired
  },
  (t) => [
    index('bulk_grants_api_key_idx').on(t.api_key_id),
    uniqueIndex('bulk_grants_token_idx').on(t.token_id),
  ],
)

// Alert webhooks, configured by the owner with `bun run webhooks:add`. Each
// belongs to one API key and stops when that key is revoked or expires. No
// secret is stored: the signing secret is derived from the Worker secret
// NUXT_WEBHOOK_SIGNING_KEY and the webhook id (layers/terminal/server/utils/webhook-sign.ts).
// secret_hash is the SHA-256 of that secret, a fingerprint for webhooks:list.
// signing_key_id names the Worker secret the secret came from, so a rotated
// key fails loudly instead of signing with a secret the client doesn't hold.
export const webhooks = sqliteTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    api_key_id: text('api_key_id').notNull(),
    url: text('url').notNull(),
    min_severity: text('min_severity').notNull(), // info | notable | critical
    secret_hash: text('secret_hash').notNull(),
    signing_key_id: text('signing_key_id').notNull(),
    status: text('status').notNull().default('active'), // active | failing | removed
    created_at: text('created_at').notNull(),
    failing_since: text('failing_since'),
    last_error: text('last_error'),
    removed_at: text('removed_at'),
  },
  (t) => [index('webhooks_api_key_idx').on(t.api_key_id)],
)

// The first time the webhook cron saw each alert. An alert's created_at is
// its evidence time, not when it was stored (a judged alert is dated by the
// changes it cites), so this is the only record of when an alert appeared:
// a webhook gets alerts first seen after it was added, and a delivery waits
// until the public site has rotated past seen_at.
export const webhookAlertLog = sqliteTable(
  'webhook_alert_log',
  {
    alert_id: text('alert_id').primaryKey(),
    seen_at: text('seen_at').notNull(),
  },
  (t) => [index('webhook_alert_log_seen_idx').on(t.seen_at)],
)

// The webhook outbox: one row per (alert, webhook), unique, so enqueueing is
// idempotent. id is the X-Frontier-Delivery header, the same on every retry.
export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhook_id: text('webhook_id').notNull(),
    alert_id: text('alert_id').notNull(),
    // queued | delivered | failed | expired | cancelled | suppressed
    status: text('status').notNull().default('queued'),
    seen_at: text('seen_at').notNull(),
    // Not sent before this: seen_at, or a judged alert's hold.
    not_before: text('not_before').notNull(),
    next_attempt_at: text('next_attempt_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    last_attempt_at: text('last_attempt_at'),
    last_status: integer('last_status'),
    last_error: text('last_error'),
    delivered_at: text('delivered_at'),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_alert_webhook_idx').on(t.alert_id, t.webhook_id),
    index('webhook_deliveries_status_next_idx').on(t.status, t.next_attempt_at),
    index('webhook_deliveries_webhook_idx').on(t.webhook_id, t.status),
  ],
)

// ─────────────────────────────────────────────
// Archived price history (layers/terminal/server/pipeline/archive/)
// ─────────────────────────────────────────────
// Price history from before this site watched the labs, read from the
// Internet Archive's captures of each lab's own pricing page. Kept apart from
// snapshots/entities/changes on purpose: those say what this store saw and
// when, and a capture we fetched in 2026 of a page as it stood in 2023 is
// neither. Nothing here moves the live floor (source_stats) or reaches the
// judge, the alert rules, or the live catalog.

// One row per Wayback capture the backfill considered: parsed, or skipped
// with the reason. The id is `<era>:<14-digit timestamp>`, so a re-run skips
// what it already holds. captured_at is when the Archive saw the page (the
// time the prices were valid); fetched_at is when we read the capture back.
export const archiveCaptures = sqliteTable(
  'archive_captures',
  {
    id: text('id').primaryKey(),
    era: text('era').notNull(),
    provider: text('provider').notNull(),
    original_url: text('original_url').notNull(),
    captured_at: text('captured_at').notNull(),
    status: text('status').notNull(), // parsed | skipped
    // pricing (archived_prices) | hiring (archived_hiring): which table the rows went to.
    axis: text('axis').notNull().default('pricing'),
    detail: text('detail'),
    content_hash: text('content_hash'),
    raw_key: text('raw_key'),
    bytes: integer('bytes'),
    rows: integer('rows').notNull(),
    ...provenance, // source_url: the Wayback capture URL (it embeds original_url)
  },
  (t) => [index('archive_captures_provider_idx').on(t.provider, t.status, t.captured_at)],
)

// One row per (capture, SKU): what the archived page priced. payload is the
// PriceRow minus its provenance, the shape entities.payload carries, so the
// read side renders both with one function. Never a live row: basis is
// always 'archived'.
export const archivedPrices = sqliteTable(
  'archived_prices',
  {
    id: text('id').primaryKey(),
    capture_id: text('capture_id').notNull(),
    entity_key: text('entity_key').notNull(),
    provider: text('provider').notNull(),
    content_hash: text('content_hash').notNull(),
    payload: text('payload').notNull(),
    captured_at: text('captured_at').notNull(),
    original_url: text('original_url').notNull(),
    basis: text('basis').notNull(), // 'archived'
    ...provenance,
  },
  (t) => [
    index('archived_prices_key_idx').on(t.entity_key, t.captured_at),
    index('archived_prices_captured_id_idx').on(t.captured_at, t.id),
  ],
)

// ─────────────────────────────────────────────
// Reliability (layers/terminal/server/pipeline/reliability/, /data#reliability)
// ─────────────────────────────────────────────
// What a due-diligence reviewer asks of the feed itself: how often each source
// answered, how stale the site got, how fast a filing reached an alert, and
// whether each deploy passed its smoke test. The reliability:record cron fills
// all four from stored rows and payloads; nothing here is typed by hand.

// One row per (source, UTC day), rolled up from source_runs so the page reads
// ~150 rows a day of history instead of every run. Re-rolled for today and
// yesterday each hour. A good run is ok, unchanged, baseline or absent (an
// answered check); a skipped run (no secret configured) is not counted.
// longest_gap_ms is the longest wait for a good run that ended this day,
// measured from the previous good run, whatever day that was.
export const sourceRunDays = sqliteTable(
  'source_run_days',
  {
    source_id: text('source_id').notNull(),
    day: text('day').notNull(), // YYYY-MM-DD, UTC
    runs: integer('runs').notNull(),
    good: integer('good').notNull(),
    first_good_at: text('first_good_at'),
    last_good_at: text('last_good_at'),
    // A gap is still open only while the source is still being checked.
    last_run_at: text('last_run_at').notNull(),
    longest_gap_ms: integer('longest_gap_ms'),
    gap_from: text('gap_from'),
    gap_to: text('gap_to'),
    rolled_at: text('rolled_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source_id, t.day] }),
    index('source_run_days_day_idx').on(t.day),
  ],
)

// One row per poll tick (scope, started_at): how many sources it ran and how
// many answered. The freshness gaps on /data#reliability are the spaces
// between ticks where most sources answered.
export const pollTicks = sqliteTable(
  'poll_ticks',
  {
    scope: text('scope').notNull(),
    started_at: text('started_at').notNull(),
    runs: integer('runs').notNull(),
    good: integer('good').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.started_at] }),
    index('poll_ticks_started_idx').on(t.started_at),
  ],
)

// One row per filing a rule alert cited (DETECTION_RULES): the first such
// alert, and EDGAR's acceptance time read back from the submissions JSON or
// filing index page already stored in R2 (never a new SEC fetch). status
// 'missing' records that no stored payload listed it; the cron retries those
// for two days, then stops. filing_date is EDGAR's, which for a filing
// accepted after 5:30 p.m. Eastern is the next business day.
export const filingDetections = sqliteTable(
  'filing_detections',
  {
    accession_no: text('accession_no').primaryKey(),
    cik: text('cik').notNull(),
    form: text('form'),
    alert_id: text('alert_id').notNull(),
    rule: text('rule').notNull(),
    headline: text('headline').notNull(),
    alerted_at: text('alerted_at').notNull(),
    status: text('status').notNull(), // found | missing
    accepted_at: text('accepted_at'),
    filing_date: text('filing_date'),
    basis: text('basis'), // submissions | filing-index
    snapshot_id: text('snapshot_id'),
    source_url: text('source_url'),
    fetched_at: text('fetched_at'),
    recorded_at: text('recorded_at').notNull(),
  },
  (t) => [
    index('filing_detections_alerted_idx').on(t.alerted_at),
    index('filing_detections_recorded_idx').on(t.recorded_at),
  ],
)

// How far the rollup above has rolled: one row, name 'source_runs'.
// rolled_through is the instant every run before it is counted; the page
// computes nothing past it, so a backfill in progress never reads as an outage.
// started is the first day the rollup holds.
export const rollupState = sqliteTable('rollup_state', {
  name: text('name').primaryKey(),
  rolled_through: text('rolled_through').notNull(),
  started: text('started').notNull(),
  updated_at: text('updated_at').notNull(),
})

// One row per run of the post-deploy smoke workflow on main
// (.github/workflows/post-deploy-smoke.yml), read from GitHub's public
// Actions API. Upserted by run id: a run seen in progress is rewritten when
// it completes. source_url is the API page it was read from.
export const deployChecks = sqliteTable(
  'deploy_checks',
  {
    run_id: text('run_id').primaryKey(),
    head_sha: text('head_sha').notNull(),
    status: text('status').notNull(), // queued | in_progress | completed
    conclusion: text('conclusion'), // success | failure | cancelled | … ; null until completed
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    html_url: text('html_url').notNull(),
    source_url: text('source_url').notNull(),
    fetched_at: text('fetched_at').notNull(),
  },
  (t) => [
    index('deploy_checks_created_idx').on(t.created_at),
    // reliabilityStamp() reads max(fetched_at) on every /api/reliability request.
    index('deploy_checks_fetched_idx').on(t.fetched_at),
  ],
)

// One row per (capture, count): what an archived job board listed. Each
// parsed capture writes one `board` row (open roles on the whole board) and,
// when the capture lists every role with its department, one `department`
// row per department, summing to the board row. `label` is the department as
// the board printed it then; `department` is the live department it files
// under (layers/terminal/server/pipeline/archive/hiring-eras.ts › liveDepartment), the label itself unless
// the board's own id ties it to a live one. Counts only: no role, title or
// person is stored. Never a live row: basis is always 'archived', and
// nothing here reaches the hiring floor, the roll-up, the judge or a thesis.
export const archivedHiring = sqliteTable(
  'archived_hiring',
  {
    id: text('id').primaryKey(),
    capture_id: text('capture_id').notNull(),
    provider: text('provider').notNull(),
    scope: text('scope').notNull(), // board | department
    label: text('label'),
    department_id: text('department_id'),
    department: text('department'),
    open_roles: integer('open_roles').notNull(),
    captured_at: text('captured_at').notNull(),
    original_url: text('original_url').notNull(),
    basis: text('basis').notNull(), // 'archived'
    ...provenance,
  },
  (t) => [
    index('archived_hiring_provider_idx').on(t.provider, t.scope, t.captured_at),
    index('archived_hiring_captured_id_idx').on(t.captured_at, t.id),
  ],
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
export type ArchivedHiringRow = typeof archivedHiring.$inferSelect
export type ApiKeyRow = typeof apiKeys.$inferSelect
export type WebhookRow = typeof webhooks.$inferSelect
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect

// ─────────────────────────────────────────────
// Task heartbeats
// ─────────────────────────────────────────────
// One row per scheduled task: when it last ran to completion and when it last
// threw. Every task file wraps its definition in withHeartbeat()
// (layers/terminal/server/utils/task-heartbeat.ts), which upserts this row when the
// run ends. The freshness checks (layers/terminal/server/utils/freshness.ts) read it
// to see a task that stopped running at all: a cron that no longer fires, a
// run killed at the CPU limit, a task that throws every tick. A task that
// catches its own failure and returns still counts as completed here; its
// failure is the job of its own ops event.
//
// first_seen_at is written once, on the first run this table records, and
// never moved: its minimum across rows is when monitoring started, so a task
// that has never run is measured from then rather than from the epoch.
export const taskHeartbeats = sqliteTable('task_heartbeats', {
  task: text('task').primaryKey(),
  first_seen_at: text('first_seen_at').notNull(),
  last_started_at: text('last_started_at').notNull(),
  last_completed_at: text('last_completed_at'),
  last_failed_at: text('last_failed_at'),
  last_error: text('last_error'),
})
