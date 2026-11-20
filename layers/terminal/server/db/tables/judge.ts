import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from './columns'

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
  (t) => [
    index('class_map_decisions_cell_idx').on(t.provider, t.class, t.decided_at),
    // terminalStamps() reads max(decided_at) on every cached request; the cell index can't serve it.
    index('class_map_decisions_decided_idx').on(t.decided_at),
  ],
)

// One row per part of a registration filing the parser could not read and
// the judge did, from a sentence the Worker found verbatim in the stored
// document (layers/terminal/server/pipeline/judge/filing-review.ts). `values`
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

// One row per page of a price list the judge read while its parser was
// failing (layers/terminal/server/pipeline/judge/price-review.ts). `readings`
// holds, for each SKU whose price changed, the run of the page it was read
// from; the row also marks the page as read, so it is offered once.
export const priceReadings = sqliteTable(
  'price_readings',
  {
    id: text('id').primaryKey(),
    source_id: text('source_id').notNull(),
    snapshot_id: text('snapshot_id').notNull(),
    content_hash: text('content_hash').notNull(),
    confirmed: integer('confirmed').notNull(),
    changed: integer('changed').notNull(),
    readings: text('readings').notNull(), // JSON
    source_url: text('source_url').notNull(),
    fetched_at: text('fetched_at').notNull(),
    read_at: text('read_at').notNull(),
  },
  (t) => [index('price_readings_source_idx').on(t.source_id, t.read_at)],
)

export type JudgeRun = typeof judgeRuns.$inferSelect

export type ClassMapDecision = typeof classMapDecisions.$inferSelect
