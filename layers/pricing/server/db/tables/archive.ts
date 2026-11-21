import { index, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// Price lists and rate limits from before this site watched the labs, read
// from the Internet Archive's captures of each lab's own pages. Each row
// names its capture in archive_captures (layers/core/server/db/tables/archive.ts),
// which logs the captures of every archived axis.

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
