// The /api/signals payload: every registered series with its lead-lag and
// event-study record against the tickers it is expected to lead, and the
// forward calls. Statistics only. No price, return series or bar is ever part
// of it (layers/signals/test/signals-private.test.ts).

export const SIGNAL_HORIZONS = [1, 5, 20, 60] as const
export type SignalHorizon = (typeof SIGNAL_HORIZONS)[number]

/** Below these, a result reads "not enough history" instead of a number. */
export const MIN_SAMPLE = {
  lead_lag: { in: 20, out: 10 },
  event: { in: 8, out: 4 },
} as const

/** The newest share of each series held out of sample. */
export const HOLDOUT_FRACTION = 1 / 3

/**
 * listed: a US symbol we price. supplier: a company listed only abroad (a Taiwan filer), by
 * its hardware-prints id. grid: a balancing authority by its EIA-930 code (ERCO, PJM, MISO).
 */
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

/** hand: registered in code and pinned by a lock test. The others record themselves daily. */
export type ForwardRule = 'hand' | 'guidance-bias' | 'prints-ratio'
export type ForwardMetric = 'revenue' | 'capex' | 'backlog'

/** One method's estimate, in USD. A range where the method gives one. */
export interface ForwardMethod {
  method: string
  value: number
  low: number | null
  high: number | null
  /** Uses an unrelated input on purpose: if it scores as well, the real input adds nothing. */
  control: boolean
}

/** An input as it stood when the call was recorded. value is null for a figure held under its source's terms. */
export interface ForwardInput {
  label: string
  value: number | null
  unit: string
  as_of: string | null
  source_url: string | null
}

/** A figure estimated before it is filed. Never edited once recorded. */
export interface ForwardCall {
  id: string
  rule: ForwardRule
  /** calibration: the inputs nearly fix the answer, so a hit proves little. */
  kind: 'forecast' | 'calibration'
  ticker: string
  metric: ForwardMetric
  fiscal_year: number
  fiscal_quarter: number | null
  period: { start: string; end: string }
  label: string
  /** The XBRL concepts that settle it, comma-separated, or `lab-revenue:<lab>`. */
  resolves_from: string
  methods: ForwardMethod[]
  inputs: ForwardInput[]
  note: string
  /** A date for a call registered in code, a timestamp for one a rule recorded. */
  recorded: string
}

export interface ForwardCallMethod extends ForwardMethod {
  /** Percent off the actual, once it is filed. */
  error_pct: number | null
  /** Whether the actual fell inside this method's range; null for a single figure or before it's filed. */
  in_range: boolean | null
}

export interface ForwardCallView extends Omit<ForwardCall, 'methods'> {
  unit: 'USD'
  methods: ForwardCallMethod[]
  actual: {
    value: number
    filed: string
    form: string
    filing_url: string
    /** Inside the call's range: the lowest to the highest non-control method. */
    in_range: boolean
  } | null
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
  /** The alpha program's waves, each its own family beside the all-tests bar above. */
  families: SignalFamilyView[]
  forward_calls: ForwardCallView[]
  forward_rule: string
  method: string
  credit: string
}

/** One registered cell of a wave: a series, a ticker, a horizon and the sign it predicted. */
export interface SignalFamilyCell {
  series: string
  ticker: string
  horizon: SignalHorizon
  direction: 'up' | 'down'
  /** The run's result for it; null while the series has no cell for that ticker. */
  cell: SignalCell | null
}

/**
 * A wave of the alpha program, corrected as its own family: its hypotheses
 * were committed before they were run (layers/signals/server/signals/waves.ts).
 */
export interface SignalFamilyView {
  id: string
  label: string
  registered: string
  /** Where the wave is argued, in the repository. */
  doc: string
  /** Registered cells' results with enough sample, in and out: the family's divisor. */
  tests: number
  bonferroni_p: number | null
  /** Registered cells that hold at the family's bar in the predicted direction. */
  holds: number
  /** Of those, the ones that also hold at the all-tests bar. */
  holds_all: number
  cells: SignalFamilyCell[]
}

/** Holds at `bonferroniP` (as signalCellHolds) with the held-out sign the wave predicted. */
export function signalFamilyCellHolds(c: SignalFamilyCell, bonferroniP: number | null): boolean {
  if (!c.cell || !signalCellHolds(c.cell, bonferroniP)) return false
  return Math.sign(c.cell.out.estimate ?? 0) === (c.direction === 'up' ? 1 : -1)
}

/** Clears the Bonferroni bar out of sample, with the same sign in sample. */
export function signalCellHolds(cell: SignalCell, bonferroniP: number | null): boolean {
  return (
    bonferroniP !== null &&
    cell.out.status === 'ok' &&
    cell.in.status === 'ok' &&
    cell.out.p_value !== null &&
    cell.out.p_value < bonferroniP &&
    Math.sign(cell.out.estimate ?? 0) === Math.sign(cell.in.estimate ?? 0)
  )
}

/**
 * clears: at least one of its tests holds. tested: it has a held-out number and none holds.
 * waiting: no test has the minimum sample yet, or the run couldn't read the series.
 */
export type SignalVerdict = 'clears' | 'tested' | 'waiting'

export interface SignalScorecardRow extends SignalSeriesView {
  verdict: SignalVerdict
  /**
   * The held-out result the row shows: the smallest p among the tests that hold, else the
   * smallest p of all its tests. Null while it waits.
   */
  best: SignalCell | null
}

export interface SignalScorecard {
  /** Series with a held-out number: those that clear first, each run by smallest p. */
  tested: SignalScorecardRow[]
  /** Series without one, in registry order. */
  waiting: SignalScorecardRow[]
  counts: {
    total: number
    tested: number
    clears: number
    fails: number
    waiting: number
    /** Of the waiting, those the run couldn't read. */
    unread: number
  }
}

const smallestP = (cells: SignalCell[]): SignalCell | null =>
  cells.reduce<SignalCell | null>(
    (a, b) => (a === null || b.out.p_value! < a.out.p_value! ? b : a),
    null,
  )

/** The scorecard's reading order. Every series lands in exactly one group. */
export function signalScorecard(
  data: Pick<SignalsData, 'series' | 'bonferroni_p'>,
): SignalScorecard {
  const rows = data.series.map((s): SignalScorecardRow => {
    const scored = s.cells.filter((c) => c.out.status === 'ok' && c.out.p_value !== null)
    const holding = scored.filter((c) => signalCellHolds(c, data.bonferroni_p))
    return {
      ...s,
      verdict: holding.length ? 'clears' : scored.length ? 'tested' : 'waiting',
      best: smallestP(holding.length ? holding : scored),
    }
  })
  const byP = (a: SignalScorecardRow, b: SignalScorecardRow) =>
    a.best!.out.p_value! - b.best!.out.p_value!
  const clears = rows.filter((r) => r.verdict === 'clears').sort(byP)
  const fails = rows.filter((r) => r.verdict === 'tested').sort(byP)
  const waiting = rows.filter((r) => r.verdict === 'waiting')
  return {
    tested: [...clears, ...fails],
    waiting,
    counts: {
      total: rows.length,
      tested: clears.length + fails.length,
      clears: clears.length,
      fails: fails.length,
      waiting: waiting.length,
      unread: waiting.filter((r) => r.error).length,
    },
  }
}
