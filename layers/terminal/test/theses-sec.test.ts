import { describe, expect, it } from 'vitest'

import { revenueGrowth } from '../server/theses/sec-signals'

// Anthropic's S-1/A periods, as the revenue axis shows them.
const period = (start: string, end: string, days: number, val: number) => ({
  start,
  end,
  days,
  val,
  form: 'S-1/A',
  filed: '2026-11-02',
  filing_url: 'https://www.sec.gov/Archives/edgar/data/2130357/000162828026068676/',
  unaudited: days < 365,
  source_url: 'https://www.sec.gov/Archives/edgar/data/2130357/000162828026068676/a.htm',
  fetched_at: '2026-11-02T16:00:00.000Z',
})

const S1 = [
  period('2026-01-01', '2026-09-30', 273, 33_242e6),
  period('2026-01-01', '2026-06-30', 181, 16_286e6),
  period('2025-01-01', '2025-12-31', 365, 4_585e6),
  period('2025-01-01', '2025-09-30', 273, 2_545e6),
  period('2025-01-01', '2025-06-30', 181, 1_163e6),
  period('2024-01-01', '2024-12-31', 366, 386e6),
  period('2023-01-01', '2023-12-31', 365, 41e6),
]

describe('revenueGrowth', () => {
  it('compares each period with the same-length period a year earlier', () => {
    const readings = revenueGrowth(S1)
    expect(readings.map((r) => [r.date, r.value])).toEqual([
      ['2024-12-31', 8.4146],
      ['2025-12-31', 10.8782],
      ['2026-06-30', 13.0034],
      ['2026-09-30', 12.0617],
    ])
    expect(readings.at(-1)!.detail).toMatchObject({
      base_date: '2025-09-30',
      base_value: 2_545e6,
      unaudited: true,
    })
  })

  it('reads the longest span when a filing reports two to one date', () => {
    const quarter = [
      ...S1,
      period('2026-07-01', '2026-09-30', 91, 16_956e6),
      period('2025-07-01', '2025-09-30', 91, 1_382e6),
    ]
    const sep = revenueGrowth(quarter).find((r) => r.date === '2026-09-30')!
    expect(sep.detail.start).toBe('2026-01-01')
  })

  it('never pairs periods of different lengths', () => {
    expect(revenueGrowth([S1[0]!, S1[2]!])).toEqual([])
  })
})
