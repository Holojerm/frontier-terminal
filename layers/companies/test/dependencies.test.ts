import { describe, expect, it } from 'vitest'

import { EXPOSURE_GAPS, FILER_NAMES, buildSeries, type StoredFact } from '../server/exposure/series'

// The dependency graph on the figures the filings carried on 2026-11-19:
// which line each tagged fact lands on and which way it points, what sizes a
// circle, what is stated as a gap, and a layout that keeps its shape.

const CIK: Record<ExposureTicker, string> = {
  MSFT: '0000789019',
  GOOGL: '0001652044',
  AMZN: '0001018724',
  META: '0001326801',
  ORCL: '0001341439',
}
const OPENAI = 'us-gaap:InvestmentIssuerNameAxis=msft:OpenAIGlobalLlcMember'
const ANTHROPIC = 'us-gaap:InvestmentIssuerNameAxis=amzn:AnthropicMember'
const RPO = 'us-gaap:RevenueRemainingPerformanceObligation'
const PPE = 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment'

function fact(
  ticker: ExposureTicker,
  concept: string,
  value: number,
  period: { start?: string; end: string },
  extra: Partial<StoredFact> = {},
): StoredFact {
  return {
    ticker,
    concept,
    dims: '',
    start: period.start ?? null,
    end: period.end,
    value,
    unit: 'USD',
    form: '10-Q',
    filed: '2026-10-30',
    accession_no: `${CIK[ticker]}-26-000040`,
    cik: CIK[ticker],
    source_url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${CIK[ticker]}.json`,
    fetched_at: '2026-11-19T18:00:00.000Z',
    ...extra,
  }
}

const Q3 = { start: '2026-07-01', end: '2026-09-30' }
const AT = { end: '2026-09-30' }

const FACTS: StoredFact[] = [
  fact('MSFT', PPE, 39_367_000_000, Q3),
  fact('MSFT', RPO, 683_000_000_000, AT),
  fact('MSFT', 'msft:EquityMethodInvestmentsTotalFundingCommitments', 13e9, AT, { dims: OPENAI }),
  fact('MSFT', 'msft:EquityMethodInvestmentsFunded', 12e9, AT, { dims: OPENAI }),
  fact('MSFT', 'us-gaap:EquityMethodInvestmentOwnershipPercentage', 0.24, AT, {
    dims: OPENAI,
    unit: 'pure',
  }),
  fact('MSFT', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 10e9, Q3, {
    dims: OPENAI,
  }),
  fact('MSFT', 'us-gaap:AccountsReceivableNet', 7.2e9, AT, { dims: OPENAI }),
  fact('MSFT', 'msft:SomethingNewOnOpenAi', 5e9, AT, { dims: OPENAI }),
  fact('GOOGL', PPE, 51_355_000_000, Q3),
  fact('GOOGL', RPO, 567_700_000_000, AT),
  fact('GOOGL', RPO, 16_800_000_000, AT, {
    dims: 'us-gaap:RelatedPartyTransactionsByRelatedPartyAxis=us-gaap:EquityMethodInvesteeMember',
  }),
  fact('AMZN', 'us-gaap:PaymentsToAcquireProductiveAssets', 77_259_000_000, Q3),
  fact('AMZN', RPO, 578_000_000_000, AT),
  fact(
    'AMZN',
    RPO,
    38_000_000_000,
    { end: '2026-03-31' },
    {
      dims: 'srt:MajorCustomersAxis=amzn:OpenAIGroupPBCMember',
    },
  ),
  fact(
    'AMZN',
    'amzn:RevenueRemainingPerformanceObligationAmountPeriodIncreaseDecrease',
    100e9,
    { start: '2026-04-01', end: '2026-06-30' },
    { dims: ANTHROPIC },
  ),
  fact(
    'AMZN',
    'us-gaap:LineOfCreditFacilityMaximumBorrowingCapacity',
    20e9,
    { end: '2026-06-30' },
    { dims: ANTHROPIC },
  ),
  fact('AMZN', 'us-gaap:InvestmentOwnedBalanceShares', 164_000_000, AT, {
    dims: ANTHROPIC,
    unit: 'shares',
  }),
  fact('META', PPE, 33_942_000_000, Q3),
  fact('ORCL', PPE, 28_499_000_000, { start: '2026-06-01', end: '2026-08-31' }),
  fact('ORCL', RPO, 664_000_000_000, { end: '2026-08-31' }),
]

const exposure = (facts: StoredFact[]): ExposureData => ({
  as_of: '2026-11-19T18:00:00.000Z',
  computed_at: '2026-11-19T18:05:00.000Z',
  rule: '',
  filers: (['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL'] as const).map((ticker) => ({
    ticker,
    name: FILER_NAMES[ticker],
    cik: CIK[ticker],
    source_url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${CIK[ticker]}.json`,
    instances: true,
    fiscal_year_end: 'December 31',
    caveat: null,
    last_read_at: '2026-11-19T18:00:00.000Z',
    instances_read: 1,
  })),
  series: buildSeries(facts),
  gaps: [...EXPOSURE_GAPS],
})

const STATEMENT =
  'In aggregate, the contractual obligations in the table below plus the short-term and subsequent commitments, as well as leases not yet commenced, each described in the paragraphs below, are approximately $900.9 billion, substantially all of which is related to compute and infrastructure.'

const FILING = {
  accession_no: '0001628280-26-074944',
  form: '424B4',
  filed: '2026-11-19',
  filing_url: 'https://www.sec.gov/Archives/edgar/data/2130357/000162828026074944/',
  source_url:
    'https://www.sec.gov/Archives/edgar/data/2130357/000162828026074944/anthropicpbc-424b4.htm',
  fetched_at: '2026-11-19T12:47:50.657Z',
}

/** Only the fields the graph reads. */
const prospectus = (filed: boolean): ProspectusData =>
  ({
    as_of: null,
    computed_at: '',
    rule: '',
    issuers: filed
      ? [
          {
            provider: 'anthropic',
            commitments: [
              {
                ...FILING,
                schedule: 'obligations_aggregate',
                as_of: null,
                audited: false,
                approximate: true,
                statement: STATEMENT,
                lines: [{ label: 'Aggregate obligations', total: 900_900_000_000, buckets: [] }],
              },
            ],
          },
        ]
      : [],
  }) as unknown as ProspectusData

const graph = buildDependencies(exposure(FACTS), prospectus(true))
const edge = (id: string) => graph.edges.find((e) => e.id === id)!
const node = (id: string) => graph.nodes.find((n) => n.id === id)!

describe('buildDependencies', () => {
  it('draws a purchase from the customer to the filer and funding from the filer to the lab', () => {
    expect(graph.edges.map((e) => e.id)).toEqual([
      'openai>MSFT:buys',
      'MSFT>openai:funds',
      'anthropic>AMZN:buys',
      'openai>AMZN:buys',
      'AMZN>anthropic:funds',
      'crux-ai>GOOGL:buys',
    ])
    expect(edge('openai>MSFT:buys')).toMatchObject({ from: 'openai', to: 'MSFT', reporter: 'MSFT' })
    expect(edge('MSFT>openai:funds')).toMatchObject({
      from: 'MSFT',
      to: 'openai',
      reporter: 'MSFT',
    })
  })

  it('sets a line’s width by its lowest-ranked dollar figure and keeps the rest under it', () => {
    const funds = edge('MSFT>openai:funds')
    expect(funds.facts.map((f) => f.short)).toEqual(['committed', 'paid in', 'stake'])
    expect(funds.weight).toMatchObject({ value: 13e9, short: 'committed', end: '2026-09-30' })
    expect(edge('openai>MSFT:buys').weight).toMatchObject({ value: 10e9, months: 3 })
    expect(edge('anthropic>AMZN:buys').weight).toMatchObject({
      value: 100e9,
      short: 'added to backlog',
      start: '2026-04-01',
      end: '2026-06-30',
    })
    // A share count never sets a width.
    expect(edge('AMZN>anthropic:funds').weight).toMatchObject({ value: 20e9, unit: 'USD' })
    expect(edge('openai>AMZN:buys').weight).toMatchObject({ value: 38e9, end: '2026-03-31' })
  })

  it('carries each figure’s filing and source', () => {
    for (const e of graph.edges) {
      for (const f of e.facts) {
        expect(f.filing_url).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/$/)
        expect(f.source_url).toMatch(/^https:\/\/data\.sec\.gov\//)
        expect(f.fetched_at).toBe('2026-11-19T18:00:00.000Z')
        expect(f.series_id).not.toBeNull()
      }
    }
  })

  it('leaves a concept it doesn’t know off the graph and says so', () => {
    expect(graph.unplaced).toEqual([
      {
        series_id: 'msft-openai-something-new-on-open-ai',
        ticker: 'MSFT',
        label: 'Something new on open ai',
      },
    ])
    expect(graph.edges.flatMap((e) => e.facts).some((f) => f.value === 5e9)).toBe(false)
  })

  it('draws the same lines from the series alone, for the dependency_edges export', () => {
    const lines = dependencyEdges(buildSeries(FACTS))
    expect(lines.edges).toEqual(graph.edges)
    expect(lines.unplaced).toEqual(graph.unplaced)
  })

  it('sizes a filer by its backlog and capex and a lab by its own filed obligations', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual([
      'openai',
      'anthropic',
      'crux-ai',
      'MSFT',
      'AMZN',
      'GOOGL',
      'META',
      'ORCL',
    ])
    expect(node('MSFT')).toMatchObject({ kind: 'filer', name: 'Microsoft', lab: null })
    expect(node('MSFT').contracts).toMatchObject({ value: 683e9, series_id: 'msft-rpo' })
    expect(node('AMZN').capex).toMatchObject({ value: 77_259_000_000, series_id: 'amzn-capex' })
    expect(node('GOOGL').lab).toBe('google')
    expect(node('META').contracts).toBeNull()
    expect(node('anthropic').contracts).toMatchObject({
      value: 900_900_000_000,
      approximate: true,
      series_id: null,
      end: null,
      form: '424B4',
      filing_url: FILING.filing_url,
      note: STATEMENT,
    })
    expect(node('anthropic').capex).toBeNull()
    expect(node('openai').contracts).toBeNull()
    expect(node('crux-ai')).toMatchObject({ kind: 'venture', name: 'Crux AI' })
  })

  it('states what isn’t drawn, with the filing’s own sentence where it has one', () => {
    const gap = (id: string) => graph.gaps.find((g) => g.id === id)
    expect(gap('anthropic-suppliers')!.reason).toContain(`“${STATEMENT}”`)
    expect(gap('openai-unfiled')!.title).toBe('OpenAI has no filing of its own here')
    expect(gap('googl-anthropic')).toBeDefined()
    expect(gap('meta-rpo')).toBeDefined()
    expect(gap('filers-without-lines')!.title).toBe('Meta and Oracle have no line')
    expect(gap('labs-not-drawn')!.title).toBe(
      'xAI, Mistral, DeepSeek, Alibaba, and Moonshot AI aren’t drawn',
    )
    expect(gap('suppliers-in-table')).toBeDefined()
  })

  it('gives a lab that hasn’t filed no size', () => {
    const before = buildDependencies(exposure(FACTS), prospectus(false))
    expect(before.nodes.find((n) => n.id === 'anthropic')!.contracts).toBeNull()
    expect(before.gaps.some((g) => g.id === 'anthropic-unfiled')).toBe(true)
  })

  it('is an empty graph with its gaps before anything is read', () => {
    const empty = buildDependencies(exposure([]), prospectus(false))
    expect(empty.edges).toEqual([])
    expect(empty.nodes.map((n) => n.kind)).toEqual(['filer', 'filer', 'filer', 'filer', 'filer'])
    expect(empty.nodes.every((n) => n.contracts === null && n.capex === null)).toBe(true)
  })
})

describe('layoutDependencies', () => {
  const at = (l: ReturnType<typeof layoutDependencies>, id: string) =>
    l.nodes.find((n) => n.id === id)!

  it('puts filers on the right, the rest on the left, and nothing on top of anything', () => {
    for (const width of [280, 640, 1100]) {
      const l = layoutDependencies(graph, 'contracts', width)
      expect(at(l, 'MSFT').x).toBeGreaterThan(at(l, 'openai').x)
      for (const n of l.nodes) {
        expect(n.x - n.r).toBeGreaterThanOrEqual(0)
        expect(n.x + n.r).toBeLessThanOrEqual(width)
        expect(n.y + n.r).toBeLessThan(l.height)
      }
      for (const side of [
        l.nodes.filter((n) => n.x < width / 2),
        l.nodes.filter((n) => n.x > width / 2),
      ]) {
        const ys = side.map((n) => n.y).sort((a, b) => a - b)
        for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(100)
      }
      expect(l.edges).toHaveLength(graph.edges.length)
    }
  })

  it('scales a circle’s area by the chosen figure and outlines one with none', () => {
    const contracts = layoutDependencies(graph, 'contracts', 640)
    // Anthropic's $900.9B is the largest contract figure on the graph.
    expect(at(contracts, 'anthropic').r).toBeGreaterThan(at(contracts, 'MSFT').r)
    expect(at(contracts, 'MSFT').r).toBeGreaterThan(at(contracts, 'AMZN').r)
    expect(at(contracts, 'openai')).toMatchObject({ hollow: true, r: 6 })
    expect(at(contracts, 'META').hollow).toBe(true)

    const capex = layoutDependencies(graph, 'capex', 640)
    expect(at(capex, 'AMZN').r).toBeGreaterThan(at(capex, 'GOOGL').r)
    expect(at(capex, 'META').hollow).toBe(false)
    expect(at(capex, 'anthropic').hollow).toBe(true)
  })

  it('bows the two lines of a pair apart and widens a line with its figure', () => {
    const l = layoutDependencies(graph, 'contracts', 640)
    const line = (id: string) => l.edges.find((e) => e.id === id)!
    const buys = line('openai>MSFT:buys')
    const funds = line('MSFT>openai:funds')
    expect(Math.abs(buys.ly - funds.ly)).toBeGreaterThan(20)
    expect(line('anthropic>AMZN:buys').width).toBe(6)
    expect(line('crux-ai>GOOGL:buys').width).toBeLessThan(line('openai>AMZN:buys').width)
    expect(buys.d).toMatch(/^M[\d.]+,[\d.]+ Q[\d.]+,[\d.-]+ [\d.]+,[\d.]+$/)
  })

  it('draws the same picture twice', () => {
    expect(layoutDependencies(graph, 'capex', 500)).toEqual(layoutDependencies(graph, 'capex', 500))
  })
})

describe('figurePeriod', () => {
  it('names a balance, a quarter, a longer flow, and an undated figure', () => {
    expect(figurePeriod({ months: null, end: '2026-09-30' })).toBe('at 2026-09-30')
    expect(figurePeriod({ months: 3, end: '2026-09-30' })).toBe('quarter to 2026-09-30')
    expect(figurePeriod({ months: 9, end: '2026-09-30' })).toBe('9 months to 2026-09-30')
    expect(figurePeriod({ months: null, end: null })).toBe('')
  })
})
