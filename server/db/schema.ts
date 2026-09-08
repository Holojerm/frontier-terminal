import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────────────
// Database Schema (Drizzle ORM + Cloudflare D1)
// ─────────────────────────────────────────────
// Convention:
//   - Table names: snake_case plural (e.g. ops_events)
//   - Column names: snake_case
//   - All tables have: id, created_at, and updated_at — unless the table is
//     append-only, in which case updated_at is omitted rather than lied about
//   - Foreign keys: <table_singular>_id (e.g. provider_id)
//
// This site has no accounts. The two tables at the top are the ops substrate
// the template shipped with; the pipeline tables below them mirror the zod
// row contracts in server/pipeline/contracts/rows.ts.
// ─────────────────────────────────────────────

// Timestamps helper — spread into every table
const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
    .notNull(),
}

// Instance secrets — server-generated derivation salts, one row each.
//
// A salt that must be stable for the life of the deployment cannot be derived
// from an operator-rotatable secret, and making it its own env var is a setup
// step every fork would have to remember. So it is generated here, once, at
// random, and never rotated (server/utils/identity.ts).
//
// Server-generated derivation material ONLY. Never user input, never anything
// rendered, never anything a request can name — an id here is chosen by code in
// this repo, so this table can never become a generic key/value store that a
// handler writes into. It holds no personal data and is not exported.
export const instanceSecrets = sqliteTable('instance_secrets', {
  // A constant chosen in code, e.g. IDENTITY_SALT_ID. Not user-supplied.
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
})

// Ops events — the alerting spool. Anything that should wake the owner up gets
// a row here, and server/tasks/ops/alert.ts drains it on a cron and emails a
// digest. This exists because Workers Logs cannot be alerted on: the only
// component that knows a request blew up is the Worker itself, at the moment
// it happens — so it writes the fact down where a cron can find it.
//
// `notified_at` is the drain marker, not a timestamp anyone reads: NULL means
// "still owed an email". Indexed because the cron filters on it every tick.
export const opsEvents = sqliteTable(
  'ops_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    kind: text('kind').notNull(), // a `kind` from the log taxonomy, e.g. server_error
    detail: text('detail'), // one-line human summary — goes in the email body
    path: text('path'), // request path, when there was one (query already stripped)
    notifiedAt: integer('notified_at', { mode: 'timestamp' }),
    ...timestamps,
  },
  (t) => [index('ops_events_notified_at_idx').on(t.notifiedAt)],
)

// Type exports — use these in your app, not raw Drizzle types
export type OpsEvent = typeof opsEvents.$inferSelect
export type NewOpsEvent = typeof opsEvents.$inferInsert

// ─────────────────────────────────────────────
// Pipeline tables
// ─────────────────────────────────────────────
// These break the camelCase convention above on purpose: the TypeScript keys
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
  (t) => [index('snapshots_source_fetched_idx').on(t.source_id, t.fetched_at)],
)

// Entities — the CURRENT row per (source, entity_key). Rows are inserted when
// an entity appears, rewritten when its content hash changes, and deleted
// when a set-typed source (a job board, a pricing page) stops listing them.
// History lives in `changes`, never in duplicate entity rows.
//
// This is a deliberate departure from the take-home, which stored every
// entity for every snapshot and reached 130k rows in two weeks — almost all
// of them byte-identical repeats of the row before. The current set plus the
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
// as server/pipeline/diff.ts computes it, so the same two snapshots always
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
    index('changes_detected_at_idx').on(t.detected_at),
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
  (t) => [index('alerts_created_at_idx').on(t.created_at)],
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
    index('source_runs_started_at_idx').on(t.started_at),
  ],
)

export type Snapshot = typeof snapshots.$inferSelect
export type Entity = typeof entities.$inferSelect
export type Change = typeof changes.$inferSelect
export type Alert = typeof alerts.$inferSelect
export type SourceRun = typeof sourceRuns.$inferSelect
