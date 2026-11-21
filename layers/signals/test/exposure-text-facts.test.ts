import { describe, expect, it } from 'vitest'

import q2023 from '~~/fixtures/filed-facts/text/amzn-2023-10-27-10-Q.htm?raw'
import k2024 from '~~/fixtures/filed-facts/text/amzn-2025-02-07-10-K.htm?raw'
import q2025 from '~~/fixtures/filed-facts/text/amzn-2025-10-31-10-Q.htm?raw'
import k2025 from '~~/fixtures/filed-facts/text/amzn-2026-02-06-10-K.htm?raw'

import { textSeries, type StoredTextFact } from '../../companies/server/exposure/series'
import { TEXT_FACT_FILERS, extractTextFacts } from '../../companies/server/exposure/text-facts'
import { firstFiledQuarters, quarterlyGrowth } from '../server/signals/sources'

const name = TEXT_FACT_FILERS.AMZN!.name
const pick = (html: string, metric: string, end: string) =>
  extractTextFacts(html, name).filter((f) => f.metric === metric && f.end === end)

describe('Amazon’s words on Anthropic', () => {
  it('reads the first note from the 10-Q for the quarter to 2023-09-30', () => {
    const facts = extractTextFacts(q2023, name)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      metric: 'notes_invested',
      start: '2023-07-01',
      end: '2023-09-30',
      value: 1_250_000_000,
      qualifier: null,
    })
    expect(facts[0]!.sentence).toMatch(/Anthropic, PBC/)
  })

  it('reads each note, the commitment and the fair value from the 2024 10-K', () => {
    expect(pick(k2024, 'notes_invested', '2024-03-31')[0]!.value).toBe(2_750_000_000)
    expect(pick(k2024, 'notes_invested', '2024-12-31')[0]!.value).toBe(1_300_000_000)
    expect(pick(k2024, 'notes_commitment', '2025-12-31')[0]!.value).toBe(2_700_000_000)
    expect(pick(k2024, 'notes_fair_value', '2024-12-31')[0]).toMatchObject({
      value: 13_800_000_000,
      qualifier: 'approximately',
    })
  })

  it('reads the gains and marks, marked primarily, from the 2025 filings', () => {
    const q3 = pick(q2025, 'upward_adjustment', '2025-09-30')
    expect(q3.map((f) => [f.start, f.value])).toEqual([
      ['2025-07-01', 7_200_000_000],
      ['2025-01-01', 7_300_000_000],
    ])
    expect(q3.every((f) => f.qualifier === 'primarily')).toBe(true)
    expect(pick(q2025, 'preferred_carrying_value', '2025-09-30')[0]!.value).toBe(16_000_000_000)
    expect(pick(k2025, 'preferred_carrying_value', '2025-12-31')[0]!.value).toBe(16_200_000_000)
    expect(pick(k2025, 'upward_adjustment', '2025-12-31')[0]).toMatchObject({
      start: '2025-01-01',
      value: 7_700_000_000,
    })
  })

  it('reads nothing from a paragraph that does not name the lab', () => {
    expect(
      extractTextFacts(
        '<div>In Q1 2024, we invested $ 2.75 billion in a second convertible note.</div>',
        name,
      ),
    ).toEqual([])
  })
})

const stored = (filed: string, end: string, value: number, start: string | null) =>
  ({
    ticker: 'AMZN',
    lab: 'anthropic',
    metric: 'notes_invested',
    concept: 'notes_invested',
    dims: 'anthropic',
    start,
    end,
    value,
    unit: 'USD',
    form: '10-Q',
    filed,
    accession_no: `acc-${filed}`,
    cik: '1018724',
    qualifier: null,
    sentence: 's',
    source_url: 'https://www.sec.gov/x.htm',
    fetched_at: '2026-11-21T00:00:00.000Z',
  }) satisfies StoredTextFact

describe('the text series', () => {
  it('quotes each point and marks the series as read from text', () => {
    const [series] = textSeries([
      stored('2023-10-27', '2023-09-30', 1.25e9, '2023-07-01'),
      stored('2024-05-01', '2023-09-30', 1.25e9, '2023-07-01'),
      stored('2024-05-01', '2024-03-31', 2.75e9, '2024-01-01'),
    ])
    expect(series!.basis).toBe('text')
    expect(series!.concept).toBe('text:notes_invested')
    expect(series!.points.map((p) => p.end)).toEqual(['2023-09-30', '2024-03-31'])
    expect(series!.points[0]!.quote).toBe('s')
  })
})

describe('hyperscaler quarters for the harness', () => {
  it('takes each quarter as first filed, public on its filing date', () => {
    expect(
      firstFiledQuarters([
        { start: '2025-07-01', end: '2025-09-30', value: -3, filed: '2025-10-29' },
        { start: '2025-07-01', end: '2025-09-30', value: -4, filed: '2026-10-28' },
        { start: '2025-01-01', end: '2025-09-30', value: -9, filed: '2025-10-29' },
      ]),
    ).toEqual([{ date: '2025-09-01', value: -3, available: '2025-10-29' }])
  })

  it('reads quarter-on-quarter growth, public on the release day or the lag', () => {
    const points = quarterlyGrowth(
      [
        { date: '2025-09-30', value: 7e9, payload: '{}' },
        { date: '2025-12-31', value: 14e9, payload: '{"released":"2026-02-04"}' },
        { date: '2026-03-31', value: 28e9, payload: '{}' },
      ],
      36,
    )
    expect(points.map((p) => p.available)).toEqual(['2026-02-04', '2026-05-06'])
    expect(points[0]!.value).toBeCloseTo(Math.log(2))
  })
})
