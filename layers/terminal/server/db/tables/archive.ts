import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

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
    // pricing (archived_prices) | hiring (archived_hiring) | gpu (archived_gpu_prices)
    // | status (archived_incidents) | limits (archived_rate_limits): which table the rows went to.
    axis: text('axis').notNull().default('pricing'),
    detail: text('detail'),
    content_hash: text('content_hash'),
    raw_key: text('raw_key'),
    bytes: integer('bytes'),
    rows: integer('rows').notNull(),
    // Status copies only: the oldest incident start the copy lists. A feed
    // holds only its newest entries, so a copy speaks for the stretch from
    // here to captured_at and no earlier; the read side counts a month only
    // as far as copies cover it.
    covers_from: text('covers_from'),
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

export type ArchivedHiringRow = typeof archivedHiring.$inferSelect

// One row per (capture, priced row): what an archived GPU rental price page
// listed, in the shape the live gpu-* recipes store (recipe_observations).
// key and payload are the live recipe's (gpu-prices.ts › gpuObservations),
// so one function renders both; value is the on-demand USD per GPU-hour.
// Never a live row: basis is always 'archived', and nothing here reaches the
// GPU median floor, the Compute thesis, the judge or the alerts.
export const archivedGpuPrices = sqliteTable(
  'archived_gpu_prices',
  {
    id: text('id').primaryKey(),
    capture_id: text('capture_id').notNull(),
    provider: text('provider').notNull(),
    key: text('key').notNull(),
    gpu: text('gpu').notNull(), // H100 | B200
    value: real('value').notNull(),
    payload: text('payload').notNull(),
    captured_at: text('captured_at').notNull(),
    original_url: text('original_url').notNull(),
    basis: text('basis').notNull(), // 'archived'
    ...provenance,
  },
  (t) => [
    index('archived_gpu_prices_provider_idx').on(t.provider, t.gpu, t.captured_at),
    index('archived_gpu_prices_captured_id_idx').on(t.captured_at, t.id),
  ],
)

// One row per incident an archived status feed listed, however many copies
// listed it: the id is <provider>:<incident id>, the feed's own id. Each field
// is the newest copy's (capture_id, captured_at, source_url say which copy);
// first_captured_at is the oldest copy that listed it. The fields are the
// live IncidentRow's, so impact is null where the feed publishes none. Never a
// live row: basis is always 'archived', and nothing here reaches entities,
// changes, the incident windows, the alerts or the judge.
export const archivedIncidents = sqliteTable(
  'archived_incidents',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    incident_id: text('incident_id').notNull(),
    title: text('title').notNull(),
    impact: text('impact'),
    status: text('status').notNull(),
    started_at: text('started_at').notNull(),
    resolved_at: text('resolved_at'),
    components: text('components').notNull(), // JSON array, sorted
    incident_url: text('incident_url').notNull(),
    capture_id: text('capture_id').notNull(),
    captured_at: text('captured_at').notNull(),
    first_captured_at: text('first_captured_at').notNull(),
    original_url: text('original_url').notNull(),
    basis: text('basis').notNull(), // 'archived'
    ...provenance,
  },
  (t) => [
    index('archived_incidents_provider_idx').on(t.provider, t.started_at),
    index('archived_incidents_captured_id_idx').on(t.captured_at, t.id),
  ],
)

export type ArchivedIncidentRow = typeof archivedIncidents.$inferSelect

// One row per (capture, limit): what an archived copy of a lab's rate-limit
// page printed, keyed as the live limits-* recipe keys its rows
// (`<model>|<tier>|<metric>`, theses/recipes/rate-limits.ts), so one function
// renders both. A usage-tier row's model names the column: spend cap, credit
// purchase to reach tier, max credit purchase, wait to reach tier. value is
// null where the copy printed no figure (N/A). Never a live row: basis is
// always 'archived', and nothing here reaches recipe_observations, the
// thesis or the judge.
export const archivedRateLimits = sqliteTable(
  'archived_rate_limits',
  {
    id: text('id').primaryKey(),
    capture_id: text('capture_id').notNull(),
    provider: text('provider').notNull(),
    recipe_id: text('recipe_id').notNull(),
    key: text('key').notNull(),
    model: text('model').notNull(),
    tier: text('tier').notNull(),
    metric: text('metric').notNull(),
    value: real('value'),
    payload: text('payload').notNull(),
    captured_at: text('captured_at').notNull(),
    original_url: text('original_url').notNull(),
    basis: text('basis').notNull(), // 'archived'
    ...provenance,
  },
  (t) => [
    index('archived_rate_limits_key_idx').on(t.recipe_id, t.key, t.captured_at),
    index('archived_rate_limits_captured_id_idx').on(t.captured_at, t.id),
  ],
)
