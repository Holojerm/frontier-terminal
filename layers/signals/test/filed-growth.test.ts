import { describe, expect, it } from 'vitest'

import type { StoredFact } from '#layers/companies/server/exposure/series'
import { familyViews } from '../server/signals/families'
import { filedGrowth, filerQuarters, isTotal } from '../server/signals/filed-growth'
import { SIGNALS } from '../server/signals/registry'
import { SIGNAL_WAVES } from '../server/signals/waves'
import type { SignalCell, SignalSeriesView, SignalStat } from '../shared/utils/signals'

const fact = (
  f: Partial<StoredFact> & Pick<StoredFact, 'end' | 'value' | 'filed'>,
): StoredFact => ({
  ticker: 'MSFT',
  concept: 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment',
  dims: '',
  start: null,
  unit: 'USD',
  form: '10-Q',
  accession_no: `acc-${f.filed}-${f.end}`,
  cik: '789019',
  source_url: 'https://www.sec.gov/',
  fetched_at: '2026-11-23T00:00:00Z',
  ...f,
})

describe('filed growth', () => {
  it('derives a quarter from year-to-date pairs and dates it at the later filing', () => {
    const q = filerQuarters(
      [
        fact({ start: '2025-07-01', end: '2025-09-30', value: 10, filed: '2025-10-29' }),
        fact({ start: '2025-07-01', end: '2025-12-31', value: 25, filed: '2026-01-28' }),
      ],
      'flow',
    )
    expect(q.get('2025-12')).toEqual({ value: 15, filed: '2026-01-28' })
  })

  it('keeps the first filing of a period, not a later restatement', () => {
    const q = filerQuarters(
      [
        fact({ start: '2025-07-01', end: '2025-09-30', value: 10, filed: '2025-10-29' }),
        fact({ start: '2025-07-01', end: '2025-09-30', value: 12, filed: '2026-10-29' }),
      ],
      'flow',
    )
    expect(q.get('2025-09')?.value).toBe(10)
  })

  it('reads a balance at each end, the total only', () => {
    expect(isTotal('', '2026-09-30')).toBe(true)
    expect(
      isTotal(
        'us-gaap:RevenueRemainingPerformanceObligationExpectedTimingOfSatisfactionStartDateAxis=2026-10-01',
        '2026-09-30',
      ),
    ).toBe(true)
    expect(
      isTotal(
        'us-gaap:RevenueRemainingPerformanceObligationExpectedTimingOfSatisfactionStartDateAxis=2027-10-01',
        '2026-09-30',
      ),
    ).toBe(false)
    const q = filerQuarters(
      [
        fact({ end: '2026-06-30', value: 100, filed: '2026-07-29' }),
        fact({
          end: '2026-06-30',
          value: 40,
          filed: '2026-07-29',
          dims: 'srt:ProductOrServiceAxis=x',
        }),
      ],
      'balance',
    )
    expect(q.get('2026-06')?.value).toBe(100)
  })

  it('sums like for like: a quarter counts only filers stated in both', () => {
    const a = new Map([
      ['2024-03', { value: 10, filed: '2024-04-25' }],
      ['2025-03', { value: 20, filed: '2025-04-24' }],
    ])
    const b = new Map([['2025-03', { value: 99, filed: '2025-04-30' }]])
    const [p] = filedGrowth([a, b], 12)
    expect(p).toEqual({ date: '2025-03-01', value: Math.log(2), available: '2025-04-24' })
  })

  it('dates a summed quarter when the last filer had filed', () => {
    const a = new Map([
      ['2024-12', { value: 10, filed: '2025-01-29' }],
      ['2025-03', { value: 11, filed: '2025-04-24' }],
    ])
    const b = new Map([
      ['2024-12', { value: 10, filed: '2025-02-06' }],
      ['2025-03', { value: 13, filed: '2025-05-01' }],
    ])
    const [p] = filedGrowth([a, b], 3)
    expect(p!.available).toBe('2025-05-01')
    expect(p!.value).toBeCloseTo(Math.log(24 / 20))
  })
})

describe('wave registration', () => {
  it('names registered series, with tickers each series is tested against', () => {
    const byId = new Map(SIGNALS.map((s) => [s.id, s]))
    for (const wave of SIGNAL_WAVES) {
      expect(wave.registered).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      const ids = wave.hypotheses.map((h) => h.series)
      expect(new Set(ids).size).toBe(ids.length)
      for (const h of wave.hypotheses) {
        const def = byId.get(h.series)
        expect(def, h.series).toBeDefined()
        for (const t of h.tickers) expect(def!.tickers, `${h.series} ${t}`).toContain(t)
      }
    }
  })

  it('keeps wave 1 to SEC facts, which read no archived row', () => {
    const wave1 = SIGNAL_WAVES.find((w) => w.id === 'wave-1')!
    const byId = new Map(SIGNALS.map((s) => [s.id, s]))
    for (const h of wave1.hypotheses) expect(byId.get(h.series)!.source.kind).toBe('filed_growth')
  })
})

describe('families', () => {
  const ok = (estimate: number, p_value: number): SignalStat => ({
    status: 'ok',
    n: 30,
    estimate,
    t_stat: 3,
    p_value,
  })
  const thin: SignalStat = { status: 'thin', n: 2, estimate: null, t_stat: null, p_value: null }
  const series = (id: string, cells: SignalCell[]): SignalSeriesView => ({
    id,
    label: id,
    entity: { kind: 'listed', id: 'MSFT', label: 'MSFT' },
    tickers: ['MSFT', 'NVDA'],
    source: 'filed_facts',
    transform: 'change',
    frequency: 'monthly',
    test: 'lead_lag',
    history_from: '2019-01-01',
    observations: 30,
    from: null,
    to: null,
    error: null,
    cells,
  })
  const wave = {
    id: 'wave-t',
    label: 'Test wave',
    registered: '2026-11-23',
    doc: 'docs/alpha-waves.md',
    hypotheses: [
      { series: 's', tickers: ['MSFT'], direction: 'up' as const, horizons: [20, 60] as const },
    ],
  }

  it('counts only registered cells and needs the predicted sign', () => {
    const views = familyViews(
      [
        series('s', [
          { ticker: 'MSFT', horizon: 20, in: ok(0.3, 0.01), out: ok(0.4, 0.001) },
          { ticker: 'MSFT', horizon: 60, in: ok(-0.3, 0.01), out: ok(-0.5, 0.0001) },
          // Unregistered: never part of the family.
          { ticker: 'NVDA', horizon: 20, in: ok(0.3, 0.01), out: ok(0.4, 1e-9) },
          { ticker: 'MSFT', horizon: 5, in: thin, out: thin },
        ]),
      ],
      0.00005,
      [wave],
    )
    const [f] = views
    expect(f!.tests).toBe(4)
    expect(f!.bonferroni_p).toBeCloseTo(0.0125)
    // 60d clears the bar but against the prediction.
    expect(f!.holds).toBe(1)
    expect(f!.holds_all).toBe(0)
  })
})
