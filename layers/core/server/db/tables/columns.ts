import { text } from 'drizzle-orm/sqlite-core'

// Every pipeline row a reader can see carries where it came from and when.
export const provenance = {
  source_url: text('source_url').notNull(),
  fetched_at: text('fetched_at').notNull(),
}

/**
 * The statuses of a source run that read its page, as a SQL list. Written into
 * the statement with sql.raw, never bound: source_runs_read_idx is a partial
 * index on exactly this list, and SQLite uses it only for a query that repeats
 * the same text.
 */
export const READ_RUN_STATUSES = "('ok', 'unchanged', 'baseline')"
