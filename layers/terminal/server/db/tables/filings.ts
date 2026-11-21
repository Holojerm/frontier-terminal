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

// Forward guidance as a company stated it. `source` says where:
//   release     the hyperscalers' capex sentence in an 8-K's exhibit 99.1
//               (layers/terminal/server/exposure/guidance.ts), one row per fiscal year;
//   exhibit     any earnings 8-K/6-K exhibit (release, CFO commentary, letter);
//   transcript  a call transcript the company posts;
//   remarks     prepared remarks the company posts;
//   audio       our transcript of the call replay (AssemblyAI), never published.
// The last four are read by layers/terminal/server/calls/, one row per figure:
// `metric` over `period_start`..`period_end`, `low`..`high` in `unit`, and
// `sentence` a quote of at most QUOTE_MAX_WORDS words. `filed` is the call or
// filing date and `accession_no` the earnings filing it went with ('' when
// none). Rows are append-only; how each was resolved is guidance_resolutions.
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
    source: text('source').notNull().default('release'),
    metric: text('metric').notNull().default('capex'), // capex | revenue | segment_revenue | ai_revenue | gross_margin | backlog
    segment: text('segment'),
    basis: text('basis'), // gaap | non_gaap, when the sentence says
    unit: text('unit').notNull().default('USD'), // USD | percent | growth_yoy | growth_qoq
    bound: text('bound').notNull().default('range'), // range | about | at_least | at_most
    fiscal_quarter: integer('fiscal_quarter'), // null for a fiscal year
    period_start: text('period_start'),
    period_end: text('period_end'),
    speaker: text('speaker'),
    at_ms: integer('at_ms'), // where in the replay the sentence starts (audio)
    page: integer('page'), // the document page it is on (PDF)
    call_document_id: text('call_document_id'),
    page_url: text('page_url'), // the company's own page for the call
    method: text('method').notNull().default('parser'), // parser | judge
    ...provenance,
  },
  (t) => [
    index('filed_guidance_filer_idx').on(t.ticker, t.fiscal_year, t.filed),
    index('filed_guidance_source_idx').on(t.source, t.ticker, t.filed),
  ],
)

// Every document an earnings call is read from (layers/terminal/server/calls/):
// the 8-K/6-K exhibits EDGAR lists, the transcripts and remarks a company
// posts (curated/earnings-calls.json), and the replays we send to AssemblyAI.
// Text and audio transcripts live in R2 under `raw_key` and are never served.
// An audio row moves pending → submitted (job_id, estimated cost) → read
// (cost from the duration AssemblyAI billed) or failed.
export const callDocuments = sqliteTable(
  'call_documents',
  {
    id: text('id').primaryKey(),
    ticker: text('ticker').notNull(),
    call_date: text('call_date').notNull(),
    period_label: text('period_label').notNull(), // the quarter the call reported, e.g. Q3 FY2027
    fiscal_year: integer('fiscal_year').notNull(),
    fiscal_quarter: integer('fiscal_quarter').notNull(),
    kind: text('kind').notNull(), // exhibit | transcript | remarks | audio
    url: text('url').notNull(),
    page_url: text('page_url'),
    produced_by: text('produced_by'), // LSEG, FactSet, S&P, Bloomberg, company, AssemblyAI
    accession_no: text('accession_no'),
    status: text('status').notNull(), // pending | submitted | read | failed | skipped
    detail: text('detail'),
    job_id: text('job_id'),
    audio_seconds: real('audio_seconds'),
    cost_usd: real('cost_usd'),
    raw_key: text('raw_key'),
    content_hash: text('content_hash'),
    statements: integer('statements').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    first_seen_at: text('first_seen_at').notNull(),
    submitted_at: text('submitted_at'),
    read_at: text('read_at'),
    judged_at: text('judged_at'),
    ...provenance,
  },
  (t) => [
    index('call_documents_status_idx').on(t.status, t.kind),
    index('call_documents_ticker_idx').on(t.ticker, t.call_date),
  ],
)

// A guidance row against the figure a later filing printed for its metric
// and period (layers/terminal/server/calls/resolve.ts). Append-only: one row
// per (guidance, filing), written the first time we hold the filed figure, so
// `first_seen_at` is when the resolution became knowable here and `filed` the
// day it became public. `error_share` is (actual - guided midpoint) / midpoint
// for a dollar figure, and actual minus midpoint in points for a percentage.
export const guidanceResolutions = sqliteTable(
  'guidance_resolutions',
  {
    id: text('id').primaryKey(),
    guidance_id: text('guidance_id').notNull(),
    ticker: text('ticker').notNull(),
    metric: text('metric').notNull(),
    actual: real('actual').notNull(),
    guided_mid: real('guided_mid').notNull(),
    error_share: real('error_share').notNull(),
    state: text('state').notNull(), // met | above | below
    concept: text('concept').notNull(),
    form: text('form').notNull(),
    filed: text('filed').notNull(),
    accession_no: text('accession_no').notNull(),
    first_seen_at: text('first_seen_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('guidance_resolutions_guidance_idx').on(t.guidance_id),
    index('guidance_resolutions_ticker_idx').on(t.ticker, t.filed),
  ],
)

export type CallDocument = typeof callDocuments.$inferSelect
export type GuidanceResolution = typeof guidanceResolutions.$inferSelect

export type FiledFact = typeof filedFacts.$inferSelect

export type FiledFactRead = typeof filedFactReads.$inferSelect
