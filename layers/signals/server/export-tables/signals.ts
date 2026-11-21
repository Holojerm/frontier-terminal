// The signals harness's statistics and the forward calls. Part of EXPORT_TABLES
// (server/registries/export-tables.ts), which fixes the order. Statistics only:
// market_bars, the prices behind them, is licensed for internal use and has no export.

import { lte } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { plainTable, type ExportTable } from '#layers/core/server/utils/terminal-export-views'

export const SIGNAL_TABLES = {
  signal_results: plainTable(
    'signal_results',
    'The signal scorecard behind /signals: for each registered series, each ticker it is expected to lead and each horizon (1, 5, 20 and 60 trading days), the in-sample and held-out statistic. For a series, the correlation between its change each period and the ticker’s return less SPY’s from the first session after the figure was public. For events, the mean of that abnormal return from the close before each event. The newest third of each series is held out. A result under the minimum sample is thin and has no estimate. Price returns from Databento daily closes, split-adjusted, without dividends. The closes themselves aren’t published.',
    tables.signalResults,
    {
      series_id: {
        type: 'text',
        key: true,
        meaning: 'The series, as /api/signals names it (npm-anthropic-sdk, launches-openai, …).',
      },
      ticker: {
        type: 'text',
        key: true,
        meaning: 'The listed company the series is tested against.',
      },
      test: {
        type: 'text',
        key: true,
        meaning: 'lead_lag for a series of figures, event for a series of dated events.',
      },
      horizon: {
        type: 'integer',
        key: true,
        unit: 'trading days',
        meaning: 'How many sessions the return runs over.',
      },
      sample: {
        type: 'text',
        key: true,
        meaning: 'in for the older two thirds of the series, out for the held-out newest third.',
      },
      status: {
        type: 'text',
        meaning: 'ok, or thin when the sample is under the minimum stated on /signals.',
      },
      n: { type: 'integer', meaning: 'Observations or event days with a return to pair with.' },
      estimate: {
        type: 'number',
        nullable: true,
        meaning:
          'lead_lag: the Pearson correlation. event: the mean abnormal return as a fraction (0.01 is 1%). Null when thin.',
      },
      t_stat: {
        type: 'number',
        nullable: true,
        meaning: 'The t statistic, on a sample shrunk where returns overlap. Null when thin.',
      },
      p_value: {
        type: 'number',
        nullable: true,
        meaning:
          'The two-sided p-value of that t statistic, before any multiple-testing correction.',
      },
      from_date: {
        type: 'date',
        nullable: true,
        meaning: 'The first observation or event in this sample.',
      },
      to_date: {
        type: 'date',
        nullable: true,
        meaning: 'The last observation or event in this sample.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The series’ row on /signals, which names the table it is read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When the harness computed the statistic, in UTC.',
      },
    },
    [
      tables.signalResults.series_id,
      tables.signalResults.ticker,
      tables.signalResults.test,
      tables.signalResults.horizon,
      tables.signalResults.sample,
    ],
    'the statistics are recomputed whole every day, so only the current run is kept.',
    undefined,
    { series_id: tables.signalResults.series_id, ticker: tables.signalResults.ticker },
  ),
  forward_calls: plainTable(
    'forward_calls',
    'Forward calls behind /signals: a company’s revenue, capex or remaining performance obligations for a period, estimated before it was filed by every method we ran, with each input as it stood. A row is inserted once and never edited; a revised estimate is a new call. rule hand rows are registered in the site’s code, where a lock pins them; guidance-bias and prints-ratio rows were recorded by a rule on the daily run. forward_call_scores holds how each settled. Research, not investment advice.',
    tables.forwardCalls,
    {
      id: { type: 'text', key: true, meaning: 'The call, as /signals and /api/signals name it.' },
      rule: {
        type: 'text',
        meaning:
          'hand; guidance-bias (the guided midpoint and its median past error); or prints-ratio (a monthly print series against how revenue tracked it).',
      },
      kind: {
        type: 'text',
        meaning: 'forecast, or calibration where the inputs nearly fix the answer.',
      },
      ticker: { type: 'text', meaning: 'The company’s ticker (ANT for Anthropic).' },
      metric: {
        type: 'text',
        meaning: 'revenue, capex, or backlog (remaining performance obligations).',
      },
      fiscal_year: { type: 'integer', meaning: 'The fiscal year, named for the year it ends in.' },
      fiscal_quarter: {
        type: 'integer',
        nullable: true,
        meaning: 'The fiscal quarter, 1 to 4; null for a whole year.',
      },
      period_start: { type: 'date', meaning: 'The first day of the period.' },
      period_end: {
        type: 'date',
        meaning: 'The last day of the period; a balance is at this date.',
      },
      label: { type: 'text', meaning: 'The call in words, e.g. Micron revenue, Q1 FY2027.' },
      resolves_from: {
        type: 'text',
        meaning:
          'The XBRL concepts that settle it, comma-separated: tried in order for revenue and backlog, summed for capex. lab-revenue:<lab> for a lab’s filed revenue.',
      },
      methods: {
        type: 'text',
        meaning:
          'JSON array: method, value, low, high (USD; low and high null for one figure), control (true when the method uses unrelated data on purpose).',
      },
      inputs: {
        type: 'text',
        meaning:
          'JSON array: label, value, unit (USD, TWD, share, ratio), as_of, source_url. value is null for a figure held under its source’s terms.',
      },
      note: { type: 'text', meaning: 'What the call rests on, in a sentence.' },
      recorded_at: {
        type: 'text',
        meaning:
          'When the call was recorded: a date for a registered call, a UTC timestamp for one a rule recorded.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The call on /signals.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning:
          'When the row was written, in UTC: recorded_at for a rule call, the first daily run after a registered call was deployed.',
      },
    },
    [tables.forwardCalls.id],
    async (_db, at) => lte(tables.forwardCalls.recorded_at, at),
    undefined,
    { ticker: tables.forwardCalls.ticker },
  ),
  forward_call_scores: plainTable(
    'forward_call_scores',
    'How each forward call settled: one row per method, written the first time we held the 10-Q or 10-K figure for the call’s period, filed after the call was recorded. Never edited.',
    tables.forwardCallScores,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of call_id, method and accession_no.',
      },
      call_id: { type: 'text', meaning: 'The forward_calls row.' },
      method: { type: 'text', meaning: 'As named in the call’s methods.' },
      control: { type: 'integer', meaning: '1 when the method uses unrelated data on purpose.' },
      estimate: { type: 'number', unit: 'USD', meaning: 'The method’s estimate.' },
      low: {
        type: 'number',
        nullable: true,
        unit: 'USD',
        meaning: 'Its range’s low end, if it gave one.',
      },
      high: {
        type: 'number',
        nullable: true,
        unit: 'USD',
        meaning: 'Its range’s high end, if it gave one.',
      },
      actual: { type: 'number', unit: 'USD', meaning: 'The filed figure.' },
      error_pct: {
        type: 'number',
        meaning: '(estimate − actual) / actual × 100. Positive is an estimate above the actual.',
      },
      in_method_range: {
        type: 'integer',
        nullable: true,
        meaning:
          '1 when the actual is inside the method’s own range, 0 when not; null for one figure.',
      },
      in_call_range: {
        type: 'integer',
        meaning: '1 when the actual is between the call’s lowest and highest non-control estimate.',
      },
      concept: {
        type: 'text',
        meaning: 'The XBRL concept the actual is (the last part, for a sum).',
      },
      form: { type: 'text', meaning: 'The filing’s form.' },
      filed: {
        type: 'date',
        meaning: 'The day the figure became public: the latest filing it needs.',
      },
      accession_no: { type: 'text', meaning: 'That filing’s EDGAR accession number.' },
      first_seen_at: { type: 'timestamp', meaning: 'When we first held the filed figure, in UTC.' },
      source_url: { type: 'text', provenance: true, meaning: 'The filing on EDGAR.' },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that figure was read, in UTC.',
      },
    },
    [tables.forwardCallScores.first_seen_at, tables.forwardCallScores.id],
    async (_db, at) => lte(tables.forwardCallScores.first_seen_at, at),
    undefined,
    { call_id: tables.forwardCallScores.call_id },
  ),
} satisfies Record<string, ExportTable>
