import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance, READ_RUN_STATUSES } from './columns'

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
    // Most panel queries filter on entity_type; without this each one scanned
    // every entity (~8.4k rows, ~10k runs a day in production).
    index('entities_type_idx').on(t.entity_type),
    // Ranking rows are read by the date inside their payload: the newest date,
    // then a window back from it. On entity_type alone both read every ranking
    // row ever stored (5.2k rows, 2.6k runs a day). The query has to spell the
    // expression the same way, '$.date' as a literal. drizzle-kit writes this
    // one wrong (it quotes the expression as column names), so its statement in
    // the migration is corrected by hand.
    index('entities_type_date_idx').on(t.entity_type, sql`json_extract(payload, '$.date')`),
  ],
)

// Changes — append-only. id is contentHash(entity_key + before/after hashes)
// as layers/terminal/server/pipeline/diff.ts computes it, so the same two snapshots always
// yield the same ids and an overlapping tick cannot log a change twice. An
// entity that makes the same transition again later (a role reposted and
// closed again) gets an id that also hashes detected_at — diff.ts › repeatChangeId.
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
    // Every panel reads one entity type's changes, some inside a date range.
    // Without this each read scanned the whole log (21k rows, 1.6k runs a day).
    index('changes_type_detected_idx').on(t.entity_type, t.detected_at),
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
  (t) => [
    index('alerts_created_id_idx').on(t.created_at, t.id),
    // The webhook outbox offers alerts by when they were written.
    index('alerts_recorded_idx').on(t.recorded_at),
  ],
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
    // Two hashes (JSON, layers/terminal/server/pipeline/refresh.ts › ParseBasis): what the
    // parse read (the page, its side snapshots, the class-map cells citing
    // it) and what it read them with (parser version, config, URL). The next
    // tick skips the parse only when both match. NULL for a failed run, a
    // source with no lane, and every run before the column.
    parse_basis: text('parse_basis'),
  },
  (t) => [
    index('source_runs_source_started_idx').on(t.source_id, t.started_at),
    index('source_runs_started_id_idx').on(t.started_at, t.id),
    // Baseline runs are a handful among tens of thousands; this finds them
    // without scanning the rest.
    index('source_runs_status_source_idx').on(t.status, t.source_id, t.started_at),
    // The newest run of a source that read its page. Walking
    // source_runs_source_started_idx for it passes every failed and absent run
    // on the way: a source that is absent on every poll, or has been failing
    // for a week, cost its whole history on each call (10.6k rows a call,
    // 6.9k calls a day). SQLite uses a partial index only when the query
    // repeats its WHERE, so both sides spell it with READ_RUN_STATUSES, and
    // the query names this index (INDEXED BY): with no statistics the planner
    // takes source_runs_source_started_idx instead.
    index('source_runs_read_idx')
      .on(t.source_id, t.started_at, t.snapshot_id)
      .where(sql`status in ${sql.raw(READ_RUN_STATUSES)}`),
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

// Alert citations — which lab and entity type each alert's cited changes
// carry, one row per distinct (alert, provider, entity_type). The lab and
// topic filters on /alerts read it. Without it they opened every alert's
// change_ids array and looked up each cited change (9.5k rows a call for 911
// alerts).
//
// Written by the alerts_cites trigger (migration 0060) on every insert into
// alerts, so no alert writer has to know about it. Alerts and changes are
// append-only and a change is always stored before the alert citing it, so
// the rows never go stale.
export const alertCites = sqliteTable(
  'alert_cites',
  {
    alert_id: text('alert_id').notNull(),
    provider: text('provider').notNull(),
    entity_type: text('entity_type').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.alert_id, t.provider, t.entity_type] }),
    index('alert_cites_provider_idx').on(t.provider, t.entity_type, t.alert_id),
    index('alert_cites_type_idx').on(t.entity_type, t.alert_id),
  ],
)

// Row counts — how many rows a table holds per key: entities per source_id,
// changes per entity_type, recipe_observations per recipe_id, alerts under ''.
// SQLite answers count(*) by reading every row, and the coverage panel, the
// overview and the fleet endpoint each asked several times a tick (24M rows a
// day). A total is the sum over a table's keys.
//
// Kept by insert and delete triggers on each counted table (migration 0060),
// so a writer cannot forget it. The key columns are identity columns that no
// writer updates; a new writer that did would need an update trigger too.
// Never INSERT OR REPLACE into a counted table: SQLite replaces the old row
// without firing its delete trigger, so the row is counted twice. Upsert with
// ON CONFLICT, as every writer does.
export const rowCounts = sqliteTable(
  'row_counts',
  {
    table_name: text('table_name').notNull(),
    key: text('key').notNull(),
    n: integer('n').notNull(),
  },
  (t) => [primaryKey({ columns: [t.table_name, t.key] })],
)

export type Snapshot = typeof snapshots.$inferSelect

export type Entity = typeof entities.$inferSelect

export type Change = typeof changes.$inferSelect

export type Alert = typeof alerts.$inferSelect

export type SourceRun = typeof sourceRuns.$inferSelect
