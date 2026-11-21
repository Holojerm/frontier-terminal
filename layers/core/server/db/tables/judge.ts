import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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

// One row per part of a registration filing the parser could not read and
// the judge did, from a sentence the Worker found verbatim in the stored
// document (layers/companies/server/pipeline/judge/filing-review.ts). `values`
// is what the Worker re-read from that sentence, not what the model said.
export const filingReadings = sqliteTable(
  'filing_readings',
  {
    id: text('id').primaryKey(),
    source_id: text('source_id').notNull(),
    accession_no: text('accession_no').notNull(),
    part: text('part').notNull(), // revenue | offering
    quote: text('quote').notNull(),
    values: text('values').notNull(), // JSON
    alert_id: text('alert_id'),
    source_url: text('source_url').notNull(),
    fetched_at: text('fetched_at').notNull(),
    read_at: text('read_at').notNull(),
  },
  (t) => [index('filing_readings_accession_idx').on(t.accession_no)],
)

export type JudgeRun = typeof judgeRuns.$inferSelect
