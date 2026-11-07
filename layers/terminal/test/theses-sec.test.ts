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
  it('compares quarters only, deriving each from year-to-date figures', () => {
    const readings = revenueGrowth(S1)
    const counted = readings.filter((r) => !r.detail.void_reason)
    // Q3 2026 (nine months less the half) against Q3 2025, derived the same way.
    expect(counted.map((r) => [r.date, r.value])).toEqual([['2026-09-30', 11.2692]])
    expect(counted[0]!.detail).toMatchObject({
      start: '2026-07-01',
      value: 16_956e6,
      derived: true,
      base_start: '2025-07-01',
      base_date: '2025-09-30',
      base_value: 1_382e6,
      base_derived: true,
      unaudited: true,
    })
  })

  it('keeps a year, a half or nine months on record but out of the count', () => {
    const voided = revenueGrowth(S1).filter((r) => r.detail.void_reason)
    // FY 2025's Q4 is derivable, but FY 2024 has no nine months to take one from.
    expect(voided.map((r) => [r.date, r.value])).toEqual([
      ['2024-12-31', 8.4146],
      ['2025-12-31', 10.8782],
      ['2026-06-30', 13.0034],
    ])
    expect(voided[2]!.detail.void_reason).toContain('181-day period to 2026-06-30')
  })

  it('reads a quarter as filed before deriving one', () => {
    const quarter = [
      ...S1,
      period('2026-07-01', '2026-09-30', 91, 17_000e6),
      period('2025-07-01', '2025-09-30', 91, 1_400e6),
    ]
    const sep = revenueGrowth(quarter).find((r) => r.date === '2026-09-30')!
    expect(sep.detail).toMatchObject({ start: '2026-07-01', value: 17_000e6, derived: false })
  })

  it('never pairs periods of different lengths', () => {
    expect(revenueGrowth([S1[0]!, S1[2]!])).toEqual([])
  })
})
