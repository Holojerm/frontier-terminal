import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from './columns'

// ─────────────────────────────────────────────
// Archive captures (layers/core/server/pipeline/archive/)
// ─────────────────────────────────────────────
// History from before this site watched the labs, read from the Internet
// Archive's captures of each source's own page. Kept apart from
// snapshots/entities/changes on purpose: those say what this store saw and
// when, and a capture we fetched in 2026 of a page as it stood in 2023 is
// neither. Nothing archived moves the live floor (source_stats) or reaches the
// judge, the alert rules, or the live catalog. Each axis's archived rows are
// its domain's table (archived_prices, archived_hiring, archived_gpu_prices,
// archived_incidents, archived_rate_limits); this is the log they share.

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
