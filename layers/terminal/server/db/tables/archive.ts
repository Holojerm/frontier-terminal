import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from './columns'

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
