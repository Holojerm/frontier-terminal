import { describe, expect, it } from 'vitest'

import {
  signalCellHolds,
  signalScorecard,
  type SignalCell,
  type SignalSeriesView,
  type SignalStat,
} from '../shared/utils/signals'

const thin: SignalStat = { status: 'thin', n: 3, estimate: null, t_stat: null, p_value: null }
const ok = (estimate: number, p_value: number): SignalStat => ({
  status: 'ok',
  n: 30,
  estimate,
  t_stat: 2,
  p_value,
})

const cell = (out: SignalStat, inSample: SignalStat = thin, ticker = 'NVDA'): SignalCell => ({
  ticker,
  horizon: 5,
  in: inSample,
  out,
})

const series = (
  id: string,
  cells: SignalCell[],
  error: string | null = null,
): SignalSeriesView => ({
  id,
  label: id,
  entity: { kind: 'lab', id: 'openai', label: 'OpenAI' },
  tickers: ['NVDA'],
  source: 'download_series',
  transform: 'change',
  frequency: 'weekly',
  test: 'lead_lag',
  history_from: '2025-01-01',
  observations: error ? 0 : 60,
  from: null,
  to: null,
  error,
  cells,
})

// 0.05 over 10 tests.
const BAR = 0.005

describe('the bar', () => {
  it('takes a held-out p under it with the same sign in sample', () => {
    expect(signalCellHolds(cell(ok(0.4, 0.001), ok(0.3, 0.2)), BAR)).toBe(true)
  })

  it('refuses a flipped sign, a thin in-sample result, a p at the bar and a run with no tests', () => {
    expect(signalCellHolds(cell(ok(0.4, 0.001), ok(-0.3, 0.2)), BAR)).toBe(false)
    expect(signalCellHolds(cell(ok(0.4, 0.001), thin), BAR)).toBe(false)
    expect(signalCellHolds(cell(ok(0.4, BAR), ok(0.3, 0.2)), BAR)).toBe(false)
    expect(signalCellHolds(cell(ok(0.4, 0.001), ok(0.3, 0.2)), null)).toBe(false)
  })
})

describe('the scorecard’s groups', () => {
  const data = {
    bonferroni_p: BAR,
    series: [
      series('waiting-a', [cell(thin)]),
      series('fails-far', [cell(ok(0.1, 0.6), ok(0.1, 0.5))]),
      series('clears-weak', [cell(ok(0.4, 0.004), ok(0.3, 0.1))]),
      series('unread', [cell(thin)], 'no rows'),
      series('fails-near', [cell(ok(0.3, 0.02), ok(0.2, 0.1))]),
      series('clears-strong', [cell(ok(-0.5, 0.0001), ok(-0.4, 0.01))]),
      // Its smallest p flips sign in sample, so only the second test holds.
      series('clears-second', [
        cell(ok(0.5, 0.0005), ok(-0.2, 0.3)),
        cell(ok(0.4, 0.002), ok(0.3, 0.1), 'AMD'),
      ]),
      // Under the bar held out, with nothing in sample to agree with.
      series('fails-no-in-sample', [cell(ok(0.5, 0.001))]),
    ],
  }
  const card = signalScorecard(data)

  it('puts every series in exactly one group', () => {
    const ids = [...card.tested, ...card.waiting].map((r) => r.id)
    expect(ids.toSorted()).toEqual(data.series.map((s) => s.id).toSorted())
    expect(new Set(ids).size).toBe(data.series.length)
  })

  it('lists the series that clear first, then the rest of the tested, each by smallest p', () => {
    expect(card.tested.map((r) => [r.id, r.verdict])).toEqual([
      ['clears-strong', 'clears'],
      ['clears-second', 'clears'],
      ['clears-weak', 'clears'],
      ['fails-no-in-sample', 'tested'],
      ['fails-near', 'tested'],
      ['fails-far', 'tested'],
    ])
  })

  it('keeps the waiting series in registry order, with no result', () => {
    expect(card.waiting.map((r) => r.id)).toEqual(['waiting-a', 'unread'])
    expect(card.waiting.every((r) => r.verdict === 'waiting' && r.best === null)).toBe(true)
  })

  it('shows the test that holds where a series clears, else its smallest p', () => {
    const best = Object.fromEntries(card.tested.map((r) => [r.id, r.best]))
    expect(best['clears-second']?.ticker).toBe('AMD')
    expect(best['clears-second']?.out.p_value).toBe(0.002)
    expect(best['fails-near']?.out.p_value).toBe(0.02)
  })

  it('counts each group', () => {
    expect(card.counts).toEqual({
      total: 8,
      tested: 6,
      clears: 3,
      fails: 3,
      waiting: 2,
      unread: 1,
    })
    expect(card.counts.clears + card.counts.fails + card.counts.waiting).toBe(card.counts.total)
  })

  it('counts every series as waiting when a run has no tests', () => {
    const empty = signalScorecard({
      bonferroni_p: null,
      series: [series('a', [cell(thin)]), series('b', [])],
    })
    expect(empty.tested).toEqual([])
    expect(empty.counts).toMatchObject({ total: 2, tested: 0, clears: 0, fails: 0, waiting: 2 })
  })
})
