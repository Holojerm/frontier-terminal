import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// ─────────────────────────────────────────────
// Hardware prints (layers/compute/server/prints/, /hardware#prints)
// ─────────────────────────────────────────────
// One row per figure as a source first showed it. Append-only: a restated month at
// a different figure adds the next vintage. Vintage chains are per source, so
// TSMC's 6-K (NT$ million) and the exchange feed (NT$ thousand) never read as
// revising each other.
export const hardwarePrints = sqliteTable(
  'hardware_prints',
  {
    id: text('id').primaryKey(),
    series: text('series').notNull(), // tw_revenue | kr_chip_exports
    entity: text('entity').notNull(), // PRINT_ENTITIES id
    // The local listing (2330.TW), or null for a country series.
    ticker: text('ticker'),
    period: text('period').notNull(), // YYYY-MM
    window: text('window').notNull(), // month | d10 | d20
    // In currency units (TWD, USD), as stated at the source's precision.
    value: real('value').notNull(),
    currency: text('currency').notNull(),
    // Year-on-year change as the release states it, or null.
    yoy_pct: real('yoy_pct'),
    observed_as: text('observed_as').notNull(), // print | prior_month | year_ago
    // 1 for the first figure this source gave for the month; 2 on for each different one after.
    vintage: integer('vintage').notNull(),
    // When we first held this figure. For a backfilled row, the time of the read.
    first_seen_at: text('first_seen_at').notNull(),
    // When the source says the release was made public (an EDGAR acceptance time), or null.
    published_at: text('published_at'),
    // The statutory deadline for the release, YYYY-MM-DD, or null.
    due_on: text('due_on'),
    basis: text('basis').notNull(), // live | backfill
    source_id: text('source_id').notNull(),
    raw_key: text('raw_key'),
    ...provenance,
  },
  (t) => [
    index('hardware_prints_key_idx').on(t.series, t.entity, t.period, t.window, t.source_id),
    index('hardware_prints_seen_idx').on(t.first_seen_at),
  ],
)

// One row per document a print source lists and we fetched once: each TSMC
// 6-K filed in the first days of a month. read: a revenue report, its figures
// are in hardware_prints. other: a 6-K about something else. failed: retried
// after a day.
export const printDocuments = sqliteTable(
  'print_documents',
  {
    doc_id: text('doc_id').primaryKey(), // the accession number
    source_id: text('source_id').notNull(),
    filed: text('filed').notNull(),
    status: text('status').notNull(),
    detail: text('detail'),
    raw_key: text('raw_key'),
    ...provenance,
  },
  (t) => [index('print_documents_source_idx').on(t.source_id, t.filed)],
)
