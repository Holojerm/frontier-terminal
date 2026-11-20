import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from './columns'

// Filed facts — append-only. One row per XBRL fact a public filer reported in
// one filing: (ticker, concept, dimensions, period, accession). A restatement
// arrives under a later accession as its own row, so the value it replaced
// stays readable as superseded. Read from company facts (non-dimensional
// facts) and from each 10-Q/10-K's own instance (the dimensional ones company
// facts drops) by layers/terminal/server/exposure/ingest.ts. `filed` is the
// filing's date, so a read as of T keeps the rows filed before T's day.
export const filedFacts = sqliteTable(
  'filed_facts',
  {
    id: text('id').primaryKey(),
    ticker: text('ticker').notNull(),
    cik: text('cik').notNull(),
    concept: text('concept').notNull(),
    dims: text('dims').notNull(), // '' when the context names no dimension
    start: text('start'), // null for a balance (an instant)
    end: text('end').notNull(),
    value: real('value').notNull(),
    unit: text('unit').notNull(),
    form: text('form').notNull(),
    filed: text('filed').notNull(),
    accession_no: text('accession_no').notNull(),
    basis: text('basis').notNull(), // companyfacts | instance
    raw_key: text('raw_key').notNull(),
    first_seen_at: text('first_seen_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('filed_facts_series_idx').on(t.ticker, t.concept, t.end),
    index('filed_facts_filed_idx').on(t.filed, t.id),
  ],
)

// Filed-fact reads — one row per document fetch: a filer's company facts,
// one filing's instance, or one earnings release (exposure/guidance.ts, where
// `facts` counts the guidance rows it printed). An instance or release read
// `ok` is never fetched again (a filing never changes once accepted); company
// facts are re-read on a schedule and skipped when their hash has not moved.
export const filedFactReads = sqliteTable(
  'filed_fact_reads',
  {
    id: text('id').primaryKey(),
    ticker: text('ticker').notNull(),
    kind: text('kind').notNull(), // companyfacts | instance | release
    accession_no: text('accession_no'), // null for company facts
    status: text('status').notNull(), // ok | unchanged | failed
    detail: text('detail'),
    content_hash: text('content_hash'),
    facts: integer('facts').notNull(),
    started_at: text('started_at').notNull(),
    source_url: text('source_url').notNull(),
  },
  (t) => [
    index('filed_fact_reads_doc_idx').on(t.ticker, t.kind, t.started_at),
    // terminalStamps() reads max(started_at) across every ticker; the doc index can't serve it.
    index('filed_fact_reads_started_idx').on(t.started_at),
  ],
)

// Capex guidance as a filer's earnings release prints it (the 8-K's exhibit
// 99.1), one row per fiscal year a release gives a figure or range for
// (layers/terminal/server/exposure/guidance.ts). `sentence` is the release's
// own sentence. A release that prints none leaves only its filed_fact_reads row.
export const filedGuidance = sqliteTable(
  'filed_guidance',
  {
    id: text('id').primaryKey(),
    ticker: text('ticker').notNull(),
    cik: text('cik').notNull(),
    accession_no: text('accession_no').notNull(),
    filed: text('filed').notNull(),
    fiscal_year: integer('fiscal_year').notNull(),
    low: real('low').notNull(),
    high: real('high').notNull(), // equal to low for a single figure
    sentence: text('sentence').notNull(),
    raw_key: text('raw_key').notNull(),
    first_seen_at: text('first_seen_at').notNull(),
    ...provenance,
  },
  (t) => [index('filed_guidance_filer_idx').on(t.ticker, t.fiscal_year, t.filed)],
)

export type FiledFact = typeof filedFacts.$inferSelect

export type FiledFactRead = typeof filedFactReads.$inferSelect
