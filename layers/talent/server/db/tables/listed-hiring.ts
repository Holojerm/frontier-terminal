import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// ─────────────────────────────────────────────
// Hiring at the listed companies (layers/talent/server/listed-hiring/, /api/hiring/listed)
// ─────────────────────────────────────────────
// A sibling of the labs' job set (entities + changes), not rows in it: every
// lab rollup, the hiring alerts and /api/hiring read entity_type 'job' by
// provider, and a CoreWeave role there would count as a lab's.
//
// One row per role a board has listed, kept after it closes: a role is open
// at an instant when first_seen_at <= t and closed_at is null or after t, so
// any past board is the table cut at that instant. A role that comes back
// after it closed reopens in place (closed_at cleared). source_url and
// fetched_at are the read the row's content last changed at; the reads
// table says when each board was last seen.
export const listedJobs = sqliteTable(
  'listed_jobs',
  {
    board_id: text('board_id').notNull(),
    job_id: text('job_id').notNull(),
    ticker: text('ticker').notNull(),
    title: text('title').notNull(),
    department: text('department'),
    location: text('location'),
    published_at: text('published_at'),
    // datacenter | infrastructure | other (layers/talent/shared/utils/listed-hiring.ts › classifyRole),
    // re-classed on every read the role is listed in.
    role_class: text('role_class').notNull(),
    first_seen_at: text('first_seen_at').notNull(),
    // The first read that no longer listed it.
    closed_at: text('closed_at'),
    ...provenance,
  },
  (t) => [
    primaryKey({ columns: [t.board_id, t.job_id] }),
    index('listed_jobs_board_closed_idx').on(t.board_id, t.closed_at),
  ],
)

// One row per read of a board: the counts as they stood then, so the series
// is what we saw at each read, not a reconstruction. A failed read has no
// counts and leaves every role as it was.
export const listedHiringReads = sqliteTable(
  'listed_hiring_reads',
  {
    // <board_id>:<read_at>
    id: text('id').primaryKey(),
    board_id: text('board_id').notNull(),
    ticker: text('ticker').notNull(),
    read_at: text('read_at').notNull(),
    // read | failed
    status: text('status').notNull(),
    detail: text('detail'),
    // Null on a failed read; total and infrastructure also on a board read
    // for its data-center roles only.
    total: integer('total'),
    datacenter: integer('datacenter'),
    infrastructure: integer('infrastructure'),
    added: integer('added'),
    closed: integer('closed'),
    content_hash: text('content_hash'),
    raw_key: text('raw_key'),
    ...provenance,
  },
  (t) => [index('listed_hiring_reads_board_read_idx').on(t.board_id, t.read_at)],
)
