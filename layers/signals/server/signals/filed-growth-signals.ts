// Wave 1 of the alpha program (docs/alpha-waves.md, registered in ./waves.ts):
// hyperscaler capex and remaining performance obligations from stored SEC
// facts. Each quarter is dated at its 10-Q or 10-K, which can trail the
// earnings release by a day (Alphabet, Amazon, Meta) or two weeks (Oracle).
// That never reads a figure early, but it measures from after the release's
// own move, so a real effect reads smaller than it is.

import type { SignalDef } from './registry'

const PPE = 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment'
const RPO = 'us-gaap:RevenueRemainingPerformanceObligation'

/** The chip and network makers a hyperscaler's capex is expected to lead (as guidance-capex-surprise-*). */
const CAPEX_LEADS = ['NVDA', 'AVGO', 'AMD', 'ANET'] as const

const filedGrowth = (
  def: Pick<SignalDef, 'id' | 'label' | 'entity' | 'tickers' | 'source' | 'history_from'>,
): SignalDef => ({
  ...def,
  transform: 'change',
  frequency: 'monthly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: 0,
})

const capex = (
  id: string,
  label: string,
  entity: string,
  filers: { ticker: string; concept: string }[],
  from: string,
) =>
  filedGrowth({
    id,
    label,
    entity: { kind: 'listed', id: entity },
    tickers: CAPEX_LEADS,
    source: { kind: 'filed_growth', filers, measure: 'flow', versus: 'year' },
    history_from: from,
  })

const rpo = (ticker: string, company: string, tickers: readonly string[], from: string) =>
  filedGrowth({
    id: `rpo-${ticker.toLowerCase()}`,
    label: `${company} remaining performance obligations, change on the quarter`,
    entity: { kind: 'listed', id: ticker },
    tickers,
    source: {
      kind: 'filed_growth',
      filers: [{ ticker, concept: RPO }],
      measure: 'balance',
      versus: 'quarter',
    },
    history_from: from,
  })

export const FILED_GROWTH_SIGNALS: readonly SignalDef[] = [
  // Oracle's quarters end a month after the others', so it is its own series.
  // Amazon tags its cash capex as productive assets.
  capex(
    'capex-hyperscalers-yoy',
    'Microsoft, Alphabet, Amazon and Meta capex, year on year',
    'MSFT',
    [
      { ticker: 'MSFT', concept: PPE },
      { ticker: 'GOOGL', concept: PPE },
      { ticker: 'AMZN', concept: 'us-gaap:PaymentsToAcquireProductiveAssets' },
      { ticker: 'META', concept: PPE },
    ],
    '2017-01-01',
  ),
  capex(
    'capex-orcl-yoy',
    'Oracle capex, year on year',
    'ORCL',
    [{ ticker: 'ORCL', concept: PPE }],
    '2017-01-01',
  ),
  rpo('MSFT', 'Microsoft', ['MSFT', 'NVDA'], '2019-01-01'),
  rpo('GOOGL', 'Alphabet', ['GOOGL', 'NVDA'], '2019-10-01'),
  rpo('AMZN', 'Amazon', ['AMZN', 'NVDA'], '2019-01-01'),
  rpo('ORCL', 'Oracle', ['ORCL', 'NVDA'], '2019-01-01'),
  rpo('HPE', 'HPE', ['HPE'], '2019-01-01'),
  rpo('CIEN', 'Ciena', ['CIEN'], '2019-01-01'),
]
