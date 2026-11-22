import { describe, expect, it } from 'vitest'

import {
  abnormalReturn,
  changesOf,
  effectiveN,
  eventDays,
  eventStudy,
  holdoutFrom,
  leadLag,
  pearson,
  periodKey,
  resample,
  sessionAfter,
  sessionBefore,
  twoSidedP,
  type Point,
} from '../server/signals/harness'
import { addDays, buildPanel, type PricePanel } from '../server/signals/market'

/** Weekday sessions from `start`, with SPY flat and TICK's closes from `close(i)`. */
function panelOf(start: string, sessions: number, close: (i: number) => number): PricePanel {
  const rows: { symbol: string; date: string; close: number }[] = []
  let date = start
  for (let i = 0; i < sessions;) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (dow !== 0 && dow !== 6) {
      rows.push({ symbol: 'SPY', date, close: 100 })
      rows.push({ symbol: 'TICK', date, close: close(i) })
      i++
    }
    date = addDays(date, 1)
  }
  return buildPanel(rows)
}

describe('periods', () => {
  it('names a week by its Monday and a month by its first day', () => {
    expect(periodKey('2026-11-20', 'week')).toBe('2026-11-16')
    expect(periodKey('2026-11-16', 'week')).toBe('2026-11-16')
    expect(periodKey('2026-11-22', 'week')).toBe('2026-11-16')
    expect(periodKey('2026-11-20', 'month')).toBe('2026-11-01')
  })

  it('sums only whole weeks and keeps the last value otherwise', () => {
    const days: Point[] = []
    for (let i = 0; i < 10; i++) days.push({ date: addDays('2026-11-02', i), value: 1 })
    expect(resample(days, 'week', 'sum')).toEqual([{ date: '2026-11-02', value: 7 }])
    expect(resample(days, 'week', 'last').map((p) => p.date)).toEqual(['2026-11-02', '2026-11-09'])
  })

  it('averages a period over half its days', () => {
    const days: Point[] = []
    for (let i = 0; i < 4; i++) days.push({ date: addDays('2026-11-02', i), value: i })
    expect(resample(days, 'week', 'mean')).toEqual([{ date: '2026-11-02', value: 1.5 }])
    expect(resample(days.slice(0, 3), 'week', 'mean')).toEqual([])
  })

  it('makes one change per consecutive pair, dated when it was public', () => {
    const weeks: Point[] = [
      { date: '2026-10-05', value: 100 },
      { date: '2026-10-12', value: 110 },
      // 2026-10-19 missing: the chain breaks
      { date: '2026-10-26', value: 120 },
      { date: '2026-11-02', value: 120 },
    ]
    const changes = changesOf(weeks, 'level', 'week', 1)
    expect(changes.map((c) => c.period)).toEqual(['2026-10-12', '2026-11-02'])
    expect(changes[0]!.x).toBeCloseTo(Math.log(1.1))
    // Week of 12 Oct ends Sunday the 18th; public a day later.
    expect(changes[0]!.available).toBe('2026-10-19')
    expect(changesOf(weeks, 'share', 'week', 0)[0]!.x).toBe(10)
  })

  it('dates a change on the day its source says it was public, before the period ends', () => {
    // Korea's first 10 days of November, released on the 11th; October's stated no time.
    const months = resample(
      [
        { date: '2026-10-01', value: 170.9 },
        { date: '2026-11-01', value: 331.2, available: '2026-11-11' },
      ],
      'month',
      'last',
    )
    expect(changesOf(months, 'change', 'month', 0).map((c) => [c.period, c.available])).toEqual([
      ['2026-10-01', '2026-10-31'],
      ['2026-11-01', '2026-11-11'],
    ])
  })
})

describe('sessions and returns', () => {
  const dates = ['2026-11-16', '2026-11-17', '2026-11-18']

  it('enters on the session after the figure is public, and measures an event from the close before it', () => {
    expect(sessionAfter(dates, '2026-11-16')).toBe(1)
    expect(sessionAfter(dates, '2026-11-15')).toBe(0)
    expect(sessionBefore(dates, '2026-11-17')).toBe(0)
    expect(sessionBefore(dates, '2026-11-16')).toBe(-1)
  })

  it('is the ticker’s return less the benchmark’s, null past the panel', () => {
    const panel = panelOf('2026-11-16', 3, (i) => 100 + 10 * i)
    expect(abnormalReturn(panel, 'TICK', 'SPY', 0, 1)).toBeCloseTo(0.1)
    expect(abnormalReturn(panel, 'TICK', 'SPY', 1, 5)).toBeNull()
    expect(abnormalReturn(panel, 'NOPE', 'SPY', 0, 1)).toBeNull()
  })
})

describe('statistics', () => {
  it('computes Pearson correlation', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1)
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1)
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull()
  })

  it('gives Student t p-values', () => {
    // t = 2.228 at 10 df is the two-sided 5% critical value.
    expect(twoSidedP(2.228, 10)!).toBeCloseTo(0.05, 3)
    expect(twoSidedP(0, 10)!).toBeCloseTo(1, 6)
    expect(twoSidedP(1.96, 100_000)!).toBeCloseTo(0.05, 3)
  })

  it('shrinks the sample where returns overlap', () => {
    expect(effectiveN(40, 5, 20)).toBe(10)
    expect(effectiveN(40, 5, 1)).toBe(40)
    expect(effectiveN(40, 5, 60)).toBe(3)
  })

  it('has no correlation with one value repeated, whatever its mean rounds to', () => {
    const same = Array.from({ length: 30 }, () => 0.1 + 0.2)
    const xs = same.map((_, i) => (i * 7) % 5)
    expect(pearson(xs, same)).toBeNull()
    expect(pearson(same, xs)).toBeNull()
  })

  it('holds out the newest third', () => {
    const dates = Array.from({ length: 30 }, (_, i) => addDays('2026-01-01', i))
    expect(holdoutFrom(dates)).toBe(dates[20])
    expect(holdoutFrom([])).toBeNull()
  })
})

describe('lead-lag', () => {
  // A signal whose change each week is next week's abnormal move.
  const weeks = 60
  const moves = Array.from({ length: weeks }, (_, i) => ((i * 7919) % 13) / 100 - 0.06)
  const panel = panelOf('2025-01-06', weeks * 5 + 80, (i) => {
    let p = 100
    for (let w = 0; w < Math.floor(i / 5); w++) p *= 1 + moves[w]!
    return p
  })

  it('finds a planted one-week lead out of sample, and nothing at a horizon too long to test', () => {
    const changes = Array.from({ length: weeks - 2 }, (_, w) => ({
      period: addDays('2025-01-06', 7 * w),
      // Public on Sunday, so the entry is Monday's close of week w + 1.
      available: addDays('2025-01-06', 7 * w + 6),
      // The planted move plus a little noise, so r is high but not exactly 1.
      x: moves[w + 1]! + ((w * 31) % 7) / 2000,
    }))
    const cells = leadLag(changes, panel, ['TICK'], 'SPY')
    const week = cells.find((c) => c.horizon === 5)!
    expect(week.in.status).toBe('ok')
    expect(week.out.status).toBe('ok')
    expect(week.out.estimate!).toBeGreaterThan(0.9)
    expect(week.out.p_value!).toBeLessThan(0.001)
    expect(week.in.n + week.out.n).toBe(changes.length)
    // 60 sessions from weekly entries: 19 held-out weeks are 1 independent return.
    expect(cells.find((c) => c.horizon === 60)!.out.status).toBe('thin')
  })

  it('leaves out changes older than the panel, and splits the hold-out over the rest', () => {
    const dated = Array.from({ length: weeks - 2 }, (_, w) => ({
      period: addDays('2025-01-06', 7 * w),
      available: addDays('2025-01-06', 7 * w + 6),
      x: moves[w + 1]! + ((w * 31) % 7) / 2000,
    }))
    // Three years of weekly changes from before the first session.
    const older = Array.from({ length: 150 }, (_, w) => ({
      period: addDays('2022-01-03', 7 * w),
      available: addDays('2022-01-03', 7 * w + 6),
      x: ((w * 17) % 11) / 100,
    }))
    const alone = leadLag(dated, panel, ['TICK'], 'SPY')
    expect(leadLag([...older, ...dated], panel, ['TICK'], 'SPY')).toEqual(alone)
    // Every change older than the panel: nothing to test, not 150 copies of one return.
    const cell = leadLag(older, panel, ['TICK'], 'SPY')[0]!
    expect(cell.in).toMatchObject({ status: 'thin', n: 0, estimate: null })
    expect(cell.out).toMatchObject({ status: 'thin', n: 0, estimate: null })
  })

  it('counts changes made public on one day as one return', () => {
    // Twelve months a release, three releases in sample: 36 changes on 3 returns.
    const batched = Array.from({ length: 72 }, (_, m) => ({
      period: addDays('2025-01-06', m),
      available: addDays('2025-01-06', 7 * 8 * Math.floor(m / 12) + 6),
      x: ((m * 37) % 17) / 100,
    }))
    const day = leadLag(batched, panel, ['TICK'], 'SPY').find((c) => c.horizon === 1)!
    expect(day.in.n).toBeGreaterThanOrEqual(MIN_SAMPLE.lead_lag.in)
    // Three returns leave one degree of freedom, which no p-value here can clear.
    expect(day.in.status === 'thin' || day.in.p_value! > 0.05).toBe(true)
    expect(day.out.status).toBe('thin')
  })

  it('reads thin under the minimum sample, with no number', () => {
    const few = Array.from({ length: MIN_SAMPLE.lead_lag.in }, (_, w) => ({
      period: addDays('2025-01-06', 7 * w),
      available: addDays('2025-01-06', 7 * w + 6),
      x: w,
    }))
    const cell = leadLag(few, panel, ['TICK'], 'SPY')[0]!
    expect(cell.out.status).toBe('thin')
    expect(cell.out.estimate).toBeNull()
    expect(cell.in.status).toBe('thin')
  })
})

describe('event study', () => {
  // TICK jumps 2% on the session of each event, and is flat otherwise.
  const eventSessions = Array.from({ length: 15 }, (_, i) => 10 + i * 12)
  const panel = panelOf(
    '2025-01-06',
    220,
    (i) => 100 * 1.02 ** eventSessions.filter((s) => s <= i).length,
  )
  const events = eventSessions.map((s) => ({
    date: panel.dates[s]!,
    value: s % 24 === 10 ? 1 : -1,
  }))

  it('averages the abnormal return from the close before each event', () => {
    const day = eventStudy(events, panel, ['TICK'], 'SPY', false).find((c) => c.horizon === 1)!
    expect(day.in.status).toBe('ok')
    expect(day.in.estimate!).toBeCloseTo(0.02, 6)
    expect(day.in.n + day.out.n).toBe(15)
  })

  it('signs each event by its value when the series is signed', () => {
    const signed = eventStudy(events, panel, ['TICK'], 'SPY', true).find((c) => c.horizon === 1)!
    const all = [...events]
    const ins = all.slice(0, 10)
    const expected = ins.reduce((s, e) => s + Math.sign(e.value) * 0.02, 0) / ins.length
    expect(signed.in.estimate!).toBeCloseTo(expected, 6)
  })

  it('splits the hold-out over the events the panel can date', () => {
    const older = Array.from({ length: 40 }, (_, i) => ({
      date: addDays('2023-01-02', i * 9),
      value: 1,
    }))
    expect(eventStudy([...older, ...events], panel, ['TICK'], 'SPY', false)).toEqual(
      eventStudy(events, panel, ['TICK'], 'SPY', false),
    )
  })

  it('folds same-day events into one', () => {
    expect(
      eventDays([
        { date: '2026-11-02', value: 1 },
        { date: '2026-11-02', value: 1 },
        { date: '2026-11-01', value: 1 },
      ]),
    ).toEqual([
      { date: '2026-11-01', value: 1 },
      { date: '2026-11-02', value: 2 },
    ])
  })
})
