import { describe, expect, it } from 'vitest'

const days = (from: string, n: number, value = 1, retrospective = false) =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
    retrospective,
  }))

describe('weeklySums', () => {
  it('sums ISO weeks, flags a week missing a day, and drops the week still running', () => {
    // Fri 2026-10-30 to Wed 2026-11-18: a partial first week, two full, one running.
    const w = weeklySums(days('2026-10-30', 20, 2))
    expect(w.map((x) => [x.week, x.days, x.total, x.partial])).toEqual([
      ['2026-10-26', 3, 6, true],
      ['2026-11-02', 7, 14, false],
      ['2026-11-09', 7, 14, false],
    ])
  })

  it('keeps a week whose Sunday is the newest day', () => {
    expect(weeklySums(days('2026-11-09', 7)).map((x) => x.week)).toEqual(['2026-11-09'])
  })

  it('marks a week retrospective when any day is, and a gap day partial', () => {
    const points = [
      ...days('2026-11-02', 3, 5, true),
      ...days('2026-11-05', 4, 5),
      ...days('2026-11-09', 2),
      ...days('2026-11-12', 4),
    ]
    const w = weeklySums(points)
    expect(w[0]).toMatchObject({
      week: '2026-11-02',
      total: 35,
      retrospective: true,
      partial: false,
    })
    expect(w[1]).toMatchObject({ week: '2026-11-09', days: 6, partial: true, retrospective: false })
  })

  it('returns nothing for no rows', () => {
    expect(weeklySums([])).toEqual([])
  })
})

describe('adoption week columns', () => {
  const weekly = [
    { week: '2026-10-19', days: 7, total: 10, partial: false },
    { week: '2026-11-02', days: 4, total: 4, partial: true },
    { week: '2026-11-09', days: 7, total: 12, partial: false },
  ]

  it('lays out every Monday so a missing week breaks the line', () => {
    const x = weekColumns('2026-10-19', '2026-11-09')
    expect(x).toEqual(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'])
    expect(weekValues(weekly, x)).toEqual([10, null, null, 12])
    expect(weekValues(weekly, x, (w) => w.total > 10)).toEqual([null, null, null, 12])
  })

  it('reads the newest full week', () => {
    expect(newestFullWeek(weekly)?.week).toBe('2026-11-09')
    expect(newestFullWeek(weekly.slice(1, 2))).toBeNull()
  })
})
