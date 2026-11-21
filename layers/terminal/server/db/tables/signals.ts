import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from './columns'

// Daily closes from Databento, licensed for internal use only. Only the signals
// harness reads this table (layers/terminal/server/signals/), and nothing that
// serves a request may: no route, export, MCP tool, page or bulk file. The
// waiver in surfaces.waivers.ts and layers/terminal/test/signals-private.test.ts
// hold that line. `close` is as traded, before any split adjustment; the
// harness adjusts at read time (layers/terminal/server/signals/market.ts › adjustSplits).
export const marketBars = sqliteTable(
  'market_bars',
  {
    symbol: text('symbol').notNull(),
    date: text('date').notNull(), // YYYY-MM-DD, the US trading session
    close: real('close').notNull(),
    volume: integer('volume').notNull(),
    // EQUS.SUMMARY (consolidated official close) or XNAS.ITCH (the last Nasdaq
    // trade before 16:00 ET, for sessions before EQUS.SUMMARY begins).
    dataset: text('dataset').notNull(),
    fetched_at: text('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] })],
)

// How far each (symbol, dataset) pull has reached, so a backfill resumes where
// it stopped and a symbol listed late is not asked for its missing years daily.
export const marketFetches = sqliteTable(
  'market_fetches',
  {
    symbol: text('symbol').notNull(),
    dataset: text('dataset').notNull(),
    start: text('start').notNull(),
    through: text('through').notNull(),
    rows: integer('rows').notNull(),
    fetched_at: text('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.dataset] })],
)

// The harness's statistics, rewritten whole on every run. Derived numbers only:
// a correlation, a mean abnormal return and its test statistic, never a price.
export const signalResults = sqliteTable(
  'signal_results',
  {
    series_id: text('series_id').notNull(),
    ticker: text('ticker').notNull(),
    test: text('test').notNull(), // lead_lag | event
    horizon: integer('horizon').notNull(), // trading days
    sample: text('sample').notNull(), // in | out
    status: text('status').notNull(), // ok | thin
    n: integer('n').notNull(),
    // lead_lag: Pearson correlation. event: mean cumulative abnormal return.
    estimate: real('estimate'),
    t_stat: real('t_stat'),
    p_value: real('p_value'),
    from_date: text('from_date'),
    to_date: text('to_date'),
    // The scorecard row that names the series' source, and when the run computed it.
    source_url: text('source_url').notNull(),
    fetched_at: text('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.series_id, t.ticker, t.test, t.horizon, t.sample] })],
)

// One row per harness run: what it read and how it ended.
export const signalRuns = sqliteTable(
  'signal_runs',
  {
    id: text('id').primaryKey(),
    started_at: text('started_at').notNull(),
    finished_at: text('finished_at'),
    status: text('status').notNull(), // ok | failed
    series: integer('series').notNull(),
    tests: integer('tests').notNull(),
    // Newest session in market_bars at run time, for the page's "prices through".
    prices_through: text('prices_through'),
    detail: text('detail'),
    // Per series: observations read and the span they cover, as JSON.
    coverage: text('coverage').notNull(),
  },
  (t) => [index('signal_runs_started_idx').on(t.started_at)],
)

export type MarketBar = typeof marketBars.$inferSelect
export type SignalResult = typeof signalResults.$inferSelect
export type SignalRun = typeof signalRuns.$inferSelect

// Forward calls: a figure estimated before it is filed, by every method we ran,
// with the inputs as they stood (layers/terminal/server/signals/forward-calls.ts).
// rule `hand` rows mirror FORWARD_CALLS in code, which a lock test pins; the
// other rules record themselves on the daily run. Rows are only ever inserted
// (layers/terminal/test/forward-calls.test.ts holds that line): a revised
// estimate is a new call with its own recorded_at.
export const forwardCalls = sqliteTable(
  'forward_calls',
  {
    id: text('id').primaryKey(),
    rule: text('rule').notNull(), // hand | guidance-bias | prints-ratio
    kind: text('kind').notNull(), // forecast | calibration
    ticker: text('ticker').notNull(),
    metric: text('metric').notNull(), // revenue | capex | backlog
    fiscal_year: integer('fiscal_year').notNull(),
    fiscal_quarter: integer('fiscal_quarter'), // null for a fiscal year
    period_start: text('period_start').notNull(),
    period_end: text('period_end').notNull(),
    label: text('label').notNull(),
    // What settles it: the XBRL concepts read (comma-separated), or `lab-revenue`.
    resolves_from: text('resolves_from').notNull(),
    // JSON: [{ method, value, low, high, control }], in USD.
    methods: text('methods').notNull(),
    // JSON: [{ label, value, unit, as_of, source_url }]; value null for a held figure.
    inputs: text('inputs').notNull(),
    note: text('note').notNull(),
    recorded_at: text('recorded_at').notNull(),
    // The call on /signals, and when it was recorded.
    ...provenance,
  },
  (t) => [
    index('forward_calls_target_idx').on(t.ticker, t.metric, t.period_end),
    index('forward_calls_recorded_idx').on(t.recorded_at),
  ],
)

// How each forward call scored: one row per method, written the first time we
// hold the filed figure for the call's period, filed after the call was recorded.
export const forwardCallScores = sqliteTable(
  'forward_call_scores',
  {
    id: text('id').primaryKey(),
    call_id: text('call_id').notNull(),
    method: text('method').notNull(),
    control: integer('control').notNull(), // 1 when the method uses an unrelated input on purpose
    estimate: real('estimate').notNull(),
    low: real('low'),
    high: real('high'),
    actual: real('actual').notNull(),
    // (estimate − actual) / actual × 100.
    error_pct: real('error_pct').notNull(),
    // 1 when the actual is inside this method's own range; null when it gave one figure.
    in_method_range: integer('in_method_range'),
    // 1 when the actual is inside the call's range: lowest to highest non-control method.
    in_call_range: integer('in_call_range').notNull(),
    concept: text('concept').notNull(),
    form: text('form').notNull(),
    filed: text('filed').notNull(),
    accession_no: text('accession_no').notNull(),
    first_seen_at: text('first_seen_at').notNull(),
    // The filing the actual comes from, and when we read it.
    ...provenance,
  },
  (t) => [index('forward_call_scores_call_idx').on(t.call_id)],
)

export type ForwardCallRow = typeof forwardCalls.$inferSelect
export type ForwardCallScore = typeof forwardCallScores.$inferSelect
