// The signals harness's statistics. Part of EXPORT_TABLES (utils/terminal-export.ts),
// which fixes the order. Statistics only: market_bars, the prices behind them,
// is licensed for internal use and has no export.

import * as tables from '#server/db/schema'
import { plainTable, type ExportTable } from '../utils/terminal-export-views'

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
} satisfies Record<string, ExportTable>
