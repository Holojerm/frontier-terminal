import { index, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// Claim readings, one row per (claim, data date): the measured value a thesis claim is
// checked against (layers/theses/server/theses). The newest date is rewritten while its
// data is still moving (OpenRouter revises trailing days). A reading whose inputs cannot
// be recomputed later (the spend premium joins today's list prices) is only ever written
// for the newest date, so a later price change never rewrites a past week.
export const claimReadings = sqliteTable(
  'claim_readings',
  {
    thesis_id: text('thesis_id').notNull(),
    claim_id: text('claim_id').notNull(),
    date: text('date').notNull(),
    value: real('value').notNull(),
    detail: text('detail').notNull(),
    computed_at: text('computed_at').notNull(),
    ...provenance,
  },
  (t) => [
    primaryKey({ columns: [t.claim_id, t.date] }),
    // terminalStamps() reads max(computed_at) on every cached request.
    index('claim_readings_computed_idx').on(t.computed_at),
  ],
)

// Claim status changes, append-only: one row each time a claim's computed status differs
// from its previous row. The thesis's revision trail and the weekly digest's input; the
// current status is the newest row per claim.
export const claimStatusChanges = sqliteTable(
  'claim_status_changes',
  {
    id: text('id').primaryKey(),
    thesis_id: text('thesis_id').notNull(),
    claim_id: text('claim_id').notNull(),
    status: text('status').notNull(), // holding | weakening | broken | unresolved
    previous_status: text('previous_status'),
    reading_date: text('reading_date'),
    reason: text('reason').notNull(),
    changed_at: text('changed_at').notNull(),
  },
  (t) => [index('claim_status_changes_claim_idx').on(t.claim_id, t.changed_at)],
)

// Claim verdicts, append-only, one per (claim, subject): the judge's rating of one
// candidate event for a judged thesis claim (layers/theses/server/theses/verdicts.ts).
// subject is what the verdict is about: the change for a price cut, the incident's
// entity_key for an outage, so an incident updated twice is rated once. facts are what
// the Worker computed (a cut's size, an outage's hours); rationale is the judge's,
// grounded against the cited change and the facts.
export const claimVerdicts = sqliteTable(
  'claim_verdicts',
  {
    id: text('id').primaryKey(),
    thesis_id: text('thesis_id').notNull(),
    claim_id: text('claim_id').notNull(),
    subject: text('subject').notNull(),
    change_id: text('change_id').notNull(),
    provider: text('provider').notNull(),
    verdict: text('verdict').notNull(),
    rationale: text('rationale').notNull(),
    facts: text('facts').notNull(),
    detected_at: text('detected_at').notNull(),
    judged_at: text('judged_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('claim_verdicts_claim_idx').on(t.claim_id, t.detected_at),
    index('claim_verdicts_judged_idx').on(t.judged_at),
  ],
)

export type ClaimReading = typeof claimReadings.$inferSelect

export type ClaimStatusChange = typeof claimStatusChanges.$inferSelect

export type ClaimVerdict = typeof claimVerdicts.$inferSelect
