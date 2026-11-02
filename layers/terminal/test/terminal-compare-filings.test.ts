import { describe, expect, it } from 'vitest'

import {
  COMPARE_PAGES,
  COMPARE_PAIRS,
  comparePath,
  parsePair,
} from '../shared/utils/terminal-compare'
import {
  filingTitle,
  headlinePeriods,
  periodName,
  revenueFilings,
} from '../shared/utils/terminal-filings'
import type {
  RevenueData,
  RevenuePeriod,
  RevenueProviderView,
} from '../shared/utils/terminal-types'

describe('compare pairs', () => {
  it('lists every unordered pair once, in LABS order', () => {
    expect(COMPARE_PAIRS).toHaveLength(15)
    expect(new Set(COMPARE_PAIRS.map((p) => comparePath(p))).size).toBe(15)
    expect(COMPARE_PAGES[0]).toMatchObject({
      path: '/compare/openai-vs-anthropic',
      title: 'OpenAI vs Anthropic',
    })
  })

  it('parses the canonical spelling, flags the reverse, and rejects the rest', () => {
    expect(parsePair('openai-vs-anthropic')).toEqual({
      pair: ['openai', 'anthropic'],
      canonical: true,
    })
    expect(parsePair('anthropic-vs-openai')).toEqual({
      pair: ['openai', 'anthropic'],
      canonical: false,
    })
    expect(parsePair('openai-vs-openai')).toBeNull()
    expect(parsePair('openai-vs-deepseek')).toBeNull()
    expect(parsePair('openai')).toBeNull()
    expect(parsePair('openai-vs-anthropic-vs-xai')).toBeNull()
  })
})

const period = (
  over: Partial<RevenuePeriod> & Pick<RevenuePeriod, 'start' | 'end' | 'days' | 'accession_no'>,
): RevenuePeriod => ({
  entity_key: `revenue:${over.accession_no}:${over.start}:${over.end}`,
  fy: null,
  fp: null,
  form: '10-Q',
  filed: '2026-10-29',
  filing_url: `https://www.sec.gov/Archives/edgar/data/1/${over.accession_no.replace(/-/g, '')}/`,
  tag: 'Revenues',
  val: 1_000_000,
  frame: null,
  basis: 'xbrl',
  unaudited: false,
  source_url: 'https://data.sec.gov/x',
  fetched_at: '2026-10-30T00:00:00Z',
  ...over,
})

const provider = (over: Partial<RevenueProviderView>): RevenueProviderView => ({
  provider: 'anthropic',
  display: 'Anthropic',
  disclosure: 'issuer',
  filer: {
    ticker: null,
    cik: '0001234567',
    entity_name: 'Anthropic, PBC',
    relation: 'issuer',
    segment: null,
    segment_label: null,
    tagged_by: 'resolved',
    resolved_from: null,
    source_id: 'prospectus-revenue-anthropic-x',
    caveat: null,
  },
  periods: [],
  superseded: [],
  tags: [],
  sources: [],
  ...over,
})

describe('periodName', () => {
  it('names calendar spans as an analyst does', () => {
    expect(periodName({ end: '2025-12-31', days: 365 })).toBe('FY2025')
    expect(periodName({ end: '2026-06-30', days: 181 })).toBe('H1 2026')
    expect(periodName({ end: '2026-09-30', days: 92 })).toBe('Q3 2026')
    expect(periodName({ end: '2026-09-30', days: 273 })).toBe('9M 2026')
  })

  it('names an off-calendar span by its length, not a quarter it is not', () => {
    expect(periodName({ end: '2026-01-31', days: 365 })).toBe('12 months to 2026-01')
    expect(periodName({ end: '2026-08-31', days: 92 })).toBe('3 months to 2026-08')
  })
})

describe('revenueFilings', () => {
  const S1 = '0001234567-26-000001'
  const Q3 = '0001234567-26-000002'
  const data: RevenueData = {
    as_of: '2026-10-30T00:00:00Z',
    computed_at: '2026-10-30T00:00:00Z',
    rule: 'rule',
    providers: [
      provider({ provider: 'openai', display: 'OpenAI', disclosure: 'none', filer: null }),
      provider({
        periods: [
          period({ accession_no: Q3, start: '2026-07-01', end: '2026-09-30', days: 92 }),
          period({ accession_no: Q3, start: '2026-01-01', end: '2026-09-30', days: 273 }),
          period({
            accession_no: Q3,
            start: '2026-01-01',
            end: '2026-06-30',
            days: 181,
            val: 2_000_000,
          }),
          period({
            accession_no: S1,
            form: 'S-1',
            filed: '2026-09-01',
            basis: 'prospectus',
            start: '2025-01-01',
            end: '2025-12-31',
            days: 365,
          }),
        ],
        superseded: [
          period({
            accession_no: S1,
            form: 'S-1',
            filed: '2026-09-01',
            basis: 'prospectus',
            unaudited: true,
            start: '2026-01-01',
            end: '2026-06-30',
            days: 181,
            val: 1_900_000,
          }),
        ],
      }),
    ],
  }

  const filings = revenueFilings(data)

  it('groups shown and restated values by accession, newest filing first', () => {
    expect(filings.map((f) => f.accession_no)).toEqual([Q3, S1])
    const s1 = filings[1]!
    expect(s1.periods.map((p) => p.end)).toEqual(['2026-06-30', '2025-12-31'])
    expect(s1.periods[0]!.restated_by).toEqual({
      accession_no: Q3,
      form: '10-Q',
      filed: '2026-10-29',
    })
    expect(s1.periods[1]!.restated_by).toBeNull()
  })

  it('titles a filing by whose revenue, which form, and which periods', () => {
    expect(filingTitle(filings[1]!)).toBe('Anthropic S-1 revenue: FY2025 and H1 2026')
    expect(filingTitle(filings[0]!)).toBe('Anthropic 10-Q revenue: Q3 2026 and 9M 2026')
  })

  it('says a parent’s filing is the parent’s', () => {
    const parent = {
      ...filings[0]!,
      provider: 'xai' as const,
      display: 'xAI',
      filer: {
        ...filings[0]!.filer,
        ticker: 'SPCX',
        entity_name: 'Space Exploration Technologies Corp.',
        relation: 'parent' as const,
      },
    }
    expect(filingTitle(parent)).toBe('SpaceX 10-Q revenue (xAI parent): Q3 2026 and 9M 2026')
    const segment = {
      ...parent,
      filer: { ...parent.filer, ticker: 'GOOGL', segment_label: 'Google Cloud' },
    }
    expect(filingTitle(segment)).toBe('Google Cloud revenue, Alphabet 10-Q: Q3 2026 and 9M 2026')
  })

  it('heads a filing with its newest end date and newest full year', () => {
    expect(headlinePeriods(filings[1]!.periods).map(periodName)).toEqual(['FY2025', 'H1 2026'])
  })
})
