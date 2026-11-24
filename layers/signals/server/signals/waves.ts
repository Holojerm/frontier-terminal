// The alpha program's waves (docs/alpha-waves.md): each wave's hypotheses,
// written down before the code that tests them, so the history shows what was
// predicted before any number came back. A wave is corrected as its own
// family over exactly these cells; the scorecard keeps the all-tests bar
// beside it. A registered hypothesis is never edited: a changed idea is a new
// wave.

export interface WaveHypothesis {
  /** A series id in the registry (./registry.ts). */
  series: string
  /** The tickers it should lead, each one of the series' own. */
  tickers: readonly string[]
  /** up: a rise in the series comes before a rise in the ticker's abnormal return. */
  direction: 'up' | 'down'
  /** The horizons the family counts, in trading days. */
  horizons: readonly SignalHorizon[]
}

export interface SignalWave {
  id: string
  label: string
  /** The day the hypotheses were committed, before any were run. */
  registered: string
  /** Where the wave is argued, in the repo. */
  doc: string
  hypotheses: readonly WaveHypothesis[]
}

const CAPEX_SUPPLIERS = ['NVDA', 'AVGO', 'AMD', 'ANET'] as const
const SLOW = [20, 60] as const

export const SIGNAL_WAVES: readonly SignalWave[] = [
  {
    id: 'wave-1',
    label: 'Wave 1: SEC filed facts',
    registered: '2026-11-23',
    doc: 'docs/alpha-waves.md#wave-1-sec-filed-facts',
    hypotheses: [
      // Hyperscaler capex growth is spending that lands as supplier revenue.
      {
        series: 'capex-hyperscalers-yoy',
        tickers: CAPEX_SUPPLIERS,
        direction: 'up',
        horizons: SLOW,
      },
      { series: 'capex-orcl-yoy', tickers: CAPEX_SUPPLIERS, direction: 'up', horizons: SLOW },
      // Backlog growth is revenue already contracted; the question is whether it
      // carries past the filing day.
      { series: 'rpo-msft', tickers: ['MSFT', 'NVDA'], direction: 'up', horizons: SLOW },
      { series: 'rpo-googl', tickers: ['GOOGL', 'NVDA'], direction: 'up', horizons: SLOW },
      { series: 'rpo-amzn', tickers: ['AMZN', 'NVDA'], direction: 'up', horizons: SLOW },
      { series: 'rpo-orcl', tickers: ['ORCL', 'NVDA'], direction: 'up', horizons: SLOW },
      { series: 'rpo-hpe', tickers: ['HPE'], direction: 'up', horizons: SLOW },
      { series: 'rpo-cien', tickers: ['CIEN'], direction: 'up', horizons: SLOW },
    ],
  },
]
