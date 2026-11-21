// The /api/signals payload: every registered series with its lead-lag and
// event-study record against the tickers it is expected to lead, and the
// forward calls. Statistics only. No price, return series or bar is ever part
// of it (layers/terminal/test/signals-private.test.ts).

import type { Stamp } from './terminal-types/common'

export const SIGNAL_HORIZONS = [1, 5, 20, 60] as const
export type SignalHorizon = (typeof SIGNAL_HORIZONS)[number]

/** Below these, a result reads "not enough history" instead of a number. */
export const MIN_SAMPLE = {
  lead_lag: { in: 20, out: 10 },
  event: { in: 8, out: 4 },
} as const

/** The newest share of each series held out of sample. */
export const HOLDOUT_FRACTION = 1 / 3

/** grid: a balancing authority by its EIA-930 code (ERCO, PJM, MISO). */
/** listed: a US symbol we price. supplier: a company listed only abroad (a Taiwan filer), by its hardware-prints id. */
export type SignalEntityKind = 'lab' | 'listed' | 'site' | 'grid' | 'supplier'
export type SignalTransform = 'level' | 'change' | 'share' | 'normalized'
export type SignalFrequency = 'daily' | 'weekly' | 'monthly' | 'event'
export type SignalTest = 'lead_lag' | 'event'

export interface SignalStat {
  status: 'ok' | 'thin'
  n: number
  /** lead_lag: correlation of the signal's change with the forward return. event: mean abnormal return. */
  estimate: number | null
  t_stat: number | null
  p_value: number | null
}

export interface SignalCell {
  ticker: string
  horizon: SignalHorizon
  in: SignalStat
  out: SignalStat
}

export interface SignalSeriesView {
  id: string
  label: string
  entity: { kind: SignalEntityKind; id: string; label: string }
  tickers: string[]
  /** The table and recipe the series is read from, as a reader can look it up on /data. */
  source: string
  transform: SignalTransform
  frequency: SignalFrequency
  test: SignalTest
  /** When the source's history starts, as registered. */
  history_from: string
  /** What the last run read: observations (or events) and their span. */
  observations: number
  from: string | null
  to: string | null
  /** Set when the run couldn't read the series. */
  error: string | null
  cells: SignalCell[]
}

export interface ForwardCallMethod {
  method: string
  value: number
  control: boolean
  /** Percent off the actual, once it is filed. */
  error_pct: number | null
}

export interface ForwardCallView {
  id: string
  ticker: string
  label: string
  metric: string
  recorded: string
  period: { start: string; end: string }
  unit: 'USD'
  methods: ForwardCallMethod[]
  prior: { label: string; value: number; basis: string }
  actual: { value: number; filed: string; filing_url: string } | null
  note: string
}

export interface SignalsData extends Stamp {
  run: {
    started_at: string
    finished_at: string | null
    status: 'ok' | 'failed'
    detail: string | null
  } | null
  /** Newest US session the harness had a close for. */
  prices_through: string | null
  /** Results with enough sample to compute: what a reader should divide 0.05 by. */
  tests: number
  bonferroni_p: number | null
  horizons: readonly number[]
  min_sample: typeof MIN_SAMPLE
  holdout: number
  series: SignalSeriesView[]
  forward_calls: ForwardCallView[]
  method: string
  credit: string
}
