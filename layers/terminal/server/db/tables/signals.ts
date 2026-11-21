import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
