import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// ─────────────────────────────────────────────
// Grid load where the lab sites are (layers/compute/server/power/grid-load*.ts, /api/grid-load)
// ─────────────────────────────────────────────
// One row per balancing authority and local day: the sum of EIA-930's hourly
// demand (EIA's adjusted series, its cleaned copy of what the authority
// reported) over the hours that carry a value. Read from EIA's six-month
// Grid Monitor files; only the authorities that hold a tracked site are kept.
// A day is restated in place when a later read of its file differs (EIA
// revises), and `fetched_at` is the read it last came from.
export const gridLoadDays = sqliteTable(
  'grid_load_days',
  {
    ba: text('ba').notNull(),
    // The authority's local date (EIA's "Data Date").
    date: text('date').notNull(),
    mwh: real('mwh').notNull(),
    hours: integer('hours').notNull(),
    // The verbatim lines of the file for the tracked authorities, in R2.
    raw_key: text('raw_key').notNull(),
    first_seen_at: text('first_seen_at').notNull(),
    ...provenance,
  },
  (t) => [primaryKey({ columns: [t.ba, t.date] })],
)

// One row per six-month file read: the walk back to 2018 and the unchanged
// check on the current half both read it.
export const gridLoadFiles = sqliteTable('grid_load_files', {
  // 2026H2
  period: text('period').primaryKey(),
  url: text('url').notNull(),
  // read | failed
  status: text('status').notNull(),
  detail: text('detail'),
  etag: text('etag'),
  content_hash: text('content_hash'),
  days: integer('days').notNull(),
  raw_key: text('raw_key'),
  read_at: text('read_at').notNull(),
})

// One row per ERCOT report read for its large-load figures: each Monthly
// Operational Overview posted on the Board of Directors pages, and each ERCOT
// Monthly on the presentations page. A report is a vintage: it is read once,
// and a later report that restates a month is stored beside it, never over it.
export const ercotLargeLoadReports = sqliteTable('ercot_large_load_reports', {
  url: text('url').primaryKey(),
  // operational-overview | monthly
  series: text('series').notNull(),
  title: text('title').notNull(),
  // The date in ERCOT's file path, the day it was posted.
  posted: text('posted').notNull(),
  // read (figures found) | none (read, no figure stated) | failed
  status: text('status').notNull(),
  detail: text('detail'),
  facts: integer('facts').notNull(),
  raw_key: text('raw_key'),
  read_at: text('read_at').notNull(),
})

// One row per figure a report states, with the sentence it was read from.
export const ercotLargeLoadFacts = sqliteTable(
  'ercot_large_load_facts',
  {
    id: text('id').primaryKey(),
    report_url: text('report_url').notNull(),
    // approved_to_energize_mw | observed_peak_mw | observed_energized_mw
    // | approved_not_operational_mw | queue_mw
    metric: text('metric').notNull(),
    // The month the figure is for (YYYY-MM): the month the sentence names, or
    // the month before the report was posted where it names none.
    period: text('period').notNull(),
    value: real('value').notNull(),
    // more than | roughly | null, as the sentence words it.
    qualifier: text('qualifier'),
    // The year a queue figure runs to ("by 2033"), when the sentence says.
    horizon: text('horizon'),
    quote: text('quote').notNull(),
    posted: text('posted').notNull(),
    raw_key: text('raw_key').notNull(),
    ...provenance,
  },
  (t) => [index('ercot_large_load_facts_metric_idx').on(t.metric, t.period)],
)
