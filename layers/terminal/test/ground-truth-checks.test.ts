import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { extractCompanyfacts } from '../server/exposure/facts'
import {
  GUIDANCE_SINCE,
  exhibitUrl,
  extractGuidance,
  guidanceIn,
  releaseDocuments,
} from '../server/exposure/guidance'
import { runFiledFacts } from '../server/exposure/ingest'
import type { StoredFact } from '../server/exposure/series'
import type { FetchOutcome, FetchSource } from '../server/pipeline/fetch'
import { figureHeadline } from '../server/pipeline/reported/figures'
import {
  applyFigureReadings,
  figureFailure,
  figureReview,
  reviewId,
  type JudgeFigure,
} from '../server/pipeline/reported/review'
import { queryContext } from '../server/utils/terminal-db'
import { queryGroundTruth } from '../server/utils/terminal-ground-truth'
import {
  dealTally,
  filerOf,
  scoreDeal,
  scoreDeals,
  type FiledAggregate,
} from '../server/utils/terminal-ground-truth-deals'
import {
  filedActual,
  fiscalYear,
  guidanceFilers,
  guidanceTally,
  scoreGuidance,
  type StoredGuidance,
} from '../server/utils/terminal-ground-truth-guidance'
import type { StoredDeal } from '../server/utils/terminal-reported'
import { fixtureText, provenanceOf } from './pipeline/fixtures'

// The two ground-truth checks beside revenue. Guidance: the parser on trimmed
// earnings releases as EDGAR served them on 2026-11-19, scored against capex
// rows from each filer's company facts the same day. Deals: real GDELT
// headlines from /export/reported_articles and real first-filed rows from
// /export/filed_facts, both read 2026-11-19. No headline had a deal label
// that day, so every label here is the one the judge's instructions ask for,
// written by hand. A test says so where it made a headline up.

const db = drizzle(env.DB, { schema })
const TOLERANCE = 5

const META = '0001326801'
const GOOGL = '0001652044'
const AMZN = '0001018724'
const ORCL = '0001341439'
const MSFT = '0000789019'

// ---- guidance -------------------------------------------------------------

const release = (name: string) =>
  extractGuidance(fixtureText(`fixtures/guidance/${name}-ex99-1.htm`))

describe('the guidance parser', () => {
  it('reads a range, with the sentence that states it', () => {
    expect(release('meta-2025-01-29')).toEqual([
      {
        fiscal_year: 2025,
        low: 60e9,
        high: 65e9,
        sentence:
          'We anticipate our full year 2025 capital expenditures will be in the range of $60-65 billion.',
      },
    ])
    // The new range, never the prior one the sentence goes on to name.
    expect(release('meta-2024-10-30')).toMatchObject([{ fiscal_year: 2024, low: 38e9, high: 40e9 }])
    expect(release('meta-2025-10-29')).toMatchObject([{ fiscal_year: 2025, low: 70e9, high: 72e9 }])
    expect(release('meta-2026-10-21')).toMatchObject([
      { fiscal_year: 2026, low: 135e9, high: 145e9 },
    ])
    expect(release('googl-2025-10-29')).toMatchObject([
      { fiscal_year: 2025, low: 91e9, high: 93e9 },
    ])
    expect(release('googl-2026-02-04')).toMatchObject([
      { fiscal_year: 2026, low: 175e9, high: 185e9 },
    ])
  })

  it('reads a single figure, before or after the words', () => {
    expect(release('googl-2025-02-04')).toMatchObject([
      { fiscal_year: 2025, low: 75e9, high: 75e9 },
    ])
    expect(release('amzn-2026-02-05')).toMatchObject([
      { fiscal_year: 2026, low: 200e9, high: 200e9 },
    ])
    expect(release('amzn-2026-10-29')).toEqual([
      {
        fiscal_year: 2026,
        low: 220e9,
        high: 220e9,
        sentence:
          'We continue to expect 2026 cash capital expenditures to be approximately $220 billion.',
      },
    ])
    // Revenue's $67 billion comes first in Oracle's sentence. Capex is the amount after the words.
    expect(release('orcl-2026-03-10')).toMatchObject([{ fiscal_year: 2026, low: 50e9, high: 50e9 }])
  })

  it('drops a bullet and the quote mark of a remark from the sentence', () => {
    expect(release('googl-2025-10-29')[0]!.sentence).toMatch(/^With the growth across/)
    expect(release('amzn-2026-02-05')[0]!.sentence).toMatch(/^With such strong demand.*capital\.$/)
  })

  it('yields nothing from a release that prints no figure', () => {
    // Microsoft's release points to the call. Alphabet's of July 2026 reports capex and guides none.
    const msft = fixtureText('fixtures/guidance/msft-2026-10-28-ex99-1.htm')
    expect(msft).toContain('earnings conference call')
    expect(extractGuidance(msft)).toEqual([])
    expect(release('googl-2026-07-22')).toEqual([])
  })

  it('takes a sentence only when it looks ahead, names a year and states billions', () => {
    expect(
      guidanceIn('Capital expenditures were $14.84 billion for the fourth quarter.'),
    ).toBeNull()
    expect(guidanceIn('We expect capital expenditures to grow in 2026.')).toBeNull()
    expect(guidanceIn('We expect capital expenditures of $50 billion.')).toBeNull()
    expect(guidanceIn('We expect 2026 revenue of $67 billion.')).toBeNull()
    expect(guidanceIn('We expect 2027 capex of $900 million.')).toBeNull()
  })
})

describe('finding the release', () => {
  it('lists the 8-Ks that carry results, newest first', () => {
    const docs = releaseDocuments(
      fixtureText('fixtures/sec/edgar-submissions-meta.json'),
      META,
      GUIDANCE_SINCE,
    )
    expect(docs.slice(0, 2)).toEqual([
      {
        accession_no: '0001628280-26-050596',
        filed: '2026-07-29',
        index_url:
          'https://www.sec.gov/Archives/edgar/data/1326801/000162828026050596/0001628280-26-050596-index.html',
      },
      expect.objectContaining({ accession_no: '0001628280-26-028364', filed: '2026-04-29' }),
    ])
    expect(() =>
      releaseDocuments(
        fixtureText('fixtures/sec/edgar-submissions-meta.json'),
        GOOGL,
        '2024-01-01',
      ),
    ).toThrow('submissions feed is for CIK')
  })

  it('finds exhibit 99.1 on the filing’s index page, and refuses another filing’s page', () => {
    const index = fixtureText('fixtures/guidance/meta-2025-01-29-index.html')
    expect(exhibitUrl(index, META, '0001326801-25-000014')).toBe(
      provenanceOf('guidance-meta-2025-01-29').source_url,
    )
    expect(() => exhibitUrl(index, META, '0001326801-25-000099')).toThrow('does not name accession')
    expect(
      exhibitUrl(
        '<table><tr><td>8-K</td></tr></table> 0001326801-25-000014',
        META,
        '0001326801-25-000014',
      ),
    ).toBeNull()
  })
})

const NOW = '2026-11-19T20:00:00.000Z'

/** A filer's company facts fixture as the store holds them. */
function facts(ticker: string, cik: string): StoredFact[] {
  const source_url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`
  return extractCompanyfacts(
    fixtureText(`fixtures/filed-facts/companyfacts-${ticker.toLowerCase()}.json`),
    cik,
  ).map((f) => ({ ...f, ticker, cik, source_url, fetched_at: NOW }))
}

const FACTS = [...facts('META', META), ...facts('GOOGL', GOOGL), ...facts('ORCL', ORCL)]

function guided(
  ticker: string,
  cik: string,
  accession_no: string,
  filed: string,
  fixture: string,
): StoredGuidance {
  const [g] = release(fixture)
  return {
    id: `${ticker}-${accession_no}`,
    ticker,
    cik,
    accession_no,
    filed,
    ...g!,
    raw_key: `guidance/${ticker.toLowerCase()}/${accession_no}.htm`,
    first_seen_at: NOW,
    source_url: provenanceOf(`guidance-${fixture}`).source_url,
    fetched_at: NOW,
  }
}

const META_FY24 = guided('META', META, '0001326801-24-000077', '2024-10-30', 'meta-2024-10-30')
const META_JAN = guided('META', META, '0001326801-25-000014', '2025-01-29', 'meta-2025-01-29')
const META_OCT = guided('META', META, '0001628280-25-047114', '2025-10-29', 'meta-2025-10-29')
const META_FY26 = guided('META', META, '0001628280-26-066700', '2026-10-21', 'meta-2026-10-21')
const GOOGL_FEB = guided('GOOGL', GOOGL, '0001652044-25-000010', '2025-02-04', 'googl-2025-02-04')
const GOOGL_OCT = guided('GOOGL', GOOGL, '0001652044-25-000087', '2025-10-29', 'googl-2025-10-29')
const GOOGL_FY26 = guided('GOOGL', GOOGL, '0001652044-26-000012', '2026-02-04', 'googl-2026-02-04')
const ORCL_FY26 = guided('ORCL', ORCL, '0001193125-26-100148', '2026-03-10', 'orcl-2026-03-10')
const AMZN_FEB = guided('AMZN', AMZN, '0001018724-26-000002', '2026-02-05', 'amzn-2026-02-05')
const AMZN_OCT = guided('AMZN', AMZN, '0001018724-26-000038', '2026-10-29', 'amzn-2026-10-29')

describe('the filed year', () => {
  it('names a fiscal year that isn’t the calendar year by its months', () => {
    expect(fiscalYear('META', 2025)).toEqual({
      start: '2025-01-01',
      end: '2025-12-31',
      period: '2025',
    })
    expect(fiscalYear('ORCL', 2026)).toEqual({
      start: '2025-06-01',
      end: '2026-05-31',
      period: 'Fiscal 2026 (June 2025 to May 2026)',
    })
    expect(fiscalYear('MSFT', 2026)).toMatchObject({ start: '2025-07-01', end: '2026-06-30' })
  })

  it('adds the two lines Meta’s figure covers, from the 10-K that first filed them', () => {
    expect(filedActual('META', 2025, FACTS)).toMatchObject({
      value: 72_215_000_000,
      parts: [
        { label: 'Purchases of property and equipment', value: 69_691_000_000 },
        { label: 'Principal payments on finance leases', value: 2_524_000_000 },
      ],
      first_filed: '2026-01-29',
      form: '10-K',
      accession_no: '0001628280-26-003942',
      filing_url: 'https://www.sec.gov/Archives/edgar/data/1326801/000162828026003942/',
    })
    expect(filedActual('META', 2024, FACTS)).toMatchObject({ value: 39_225_000_000 })
    expect(filedActual('GOOGL', 2025, FACTS)).toMatchObject({
      value: 91_447_000_000,
      first_filed: '2026-02-05',
      accession_no: '0001652044-26-000018',
    })
    expect(filedActual('ORCL', 2026, FACTS)).toMatchObject({
      value: 55_663_000_000,
      first_filed: '2026-06-22',
    })
  })

  it('has no figure for a year not filed, or for a filer we can’t score', () => {
    expect(filedActual('META', 2026, FACTS)).toBeNull()
    expect(filedActual('AMZN', 2025, FACTS)).toBeNull()
    expect(filedActual('MSFT', 2025, FACTS)).toBeNull()
  })
})

describe('scoring guidance', () => {
  const score = (g: StoredGuidance) => scoreGuidance(g, FACTS, TOLERANCE)

  it('calls a range met when the filed year is inside it', () => {
    expect(score(META_FY24)).toMatchObject({
      state: 'met',
      error_pct: 0,
      lead_days: 92,
      actual: { value: 39_225_000_000, first_filed: '2025-01-30' },
    })
    expect(score(GOOGL_OCT)).toMatchObject({ state: 'met', error_pct: 0, lead_days: 99 })
  })

  it('measures a year outside the range from the nearer end', () => {
    const jan = score(META_JAN)
    expect(jan).toMatchObject({ state: 'above', period: '2025', lead_days: 365 })
    expect(jan.error_pct).toBeCloseTo(11.1, 1)
    // $215 million over the top of a $70-72 billion range is outside it.
    const oct = score(META_OCT)
    expect(oct.state).toBe('above')
    expect(oct.error_pct).toBeCloseTo(0.3, 1)
  })

  it('allows a single figure the tolerance, and no more', () => {
    const feb = score(GOOGL_FEB)
    expect(feb).toMatchObject({ state: 'above', filer: 'Alphabet' })
    expect(feb.error_pct).toBeCloseTo(21.9, 1)
    const orcl = score(ORCL_FY26)
    expect(orcl).toMatchObject({
      state: 'above',
      period: 'Fiscal 2026 (June 2025 to May 2026)',
      lead_days: 104,
    })
    expect(orcl.error_pct).toBeCloseTo(11.3, 1)
    expect(scoreGuidance({ ...ORCL_FY26, low: 54e9, high: 54e9 }, FACTS, TOLERANCE).state).toBe(
      'met',
    )
    expect(scoreGuidance({ ...ORCL_FY26, low: 60e9, high: 60e9 }, FACTS, TOLERANCE).state).toBe(
      'below',
    )
  })

  it('leaves a year open until its 10-K is filed, and after it', () => {
    expect(score(META_FY26)).toMatchObject({ state: 'open', actual: null, error_pct: null })
    expect(score(GOOGL_FY26).state).toBe('open')
    // A release filed with the year's own results isn't a forecast of it.
    expect(score({ ...META_OCT, filed: '2026-01-29' }).state).toBe('open')
  })

  it('lists Amazon’s figures and never scores them', () => {
    expect(score(AMZN_FEB)).toMatchObject({ state: 'unsettled', actual: null, lead_days: null })
    expect(score(AMZN_OCT).state).toBe('unsettled')
  })

  it('tallies each result, and says per filer what its releases print', () => {
    const rows = [
      META_FY24,
      META_JAN,
      META_OCT,
      META_FY26,
      GOOGL_FEB,
      GOOGL_OCT,
      GOOGL_FY26,
      ORCL_FY26,
      AMZN_FEB,
      AMZN_OCT,
    ]
    const tally = guidanceTally(rows.map(score))
    expect(tally).toMatchObject({
      figures: 10,
      scored: 6,
      met: 2,
      above: 4,
      below: 0,
      open: 2,
      unsettled: 2,
    })
    expect(tally.median_miss_pct).toBeCloseTo(11.2, 1)

    const reads = [
      ...rows.map((g) => ({ ticker: g.ticker, accession_no: g.accession_no })),
      { ticker: 'GOOGL', accession_no: '0001652044-26-000066' },
      { ticker: 'MSFT', accession_no: '0001193125-26-431000' },
    ]
    const filers = guidanceFilers(reads, rows)
    expect(filers.map((f) => [f.ticker, f.releases_read, f.releases_with_figure])).toEqual([
      ['META', 4, 4],
      ['GOOGL', 4, 3],
      ['ORCL', 1, 1],
      ['AMZN', 2, 2],
      ['MSFT', 1, 0],
    ])
    expect(filers.find((f) => f.ticker === 'MSFT')!.gap).toContain('earnings call')
    expect(filers.find((f) => f.ticker === 'AMZN')!.gap).toContain('less proceeds')
    expect(filers.find((f) => f.ticker === 'META')!.gap).toBeNull()
  })
})

// ---- deals ----------------------------------------------------------------

const FOUND = '2026-11-07T22:29:22.232Z'

function deal(
  title: string,
  outlet: string,
  published_at: string,
  over: Partial<StoredDeal> & Pick<StoredDeal, 'metric' | 'amount' | 'amount_text'>,
): StoredDeal {
  const url = `https://${outlet}/${encodeURIComponent(title)}`
  return {
    lab: 'anthropic',
    basis: 'reported',
    currency: 'USD',
    counterparty: null,
    title,
    outlet,
    url,
    published_at,
    outlets: 1,
    source_url: url,
    fetched_at: FOUND,
    found_at: FOUND,
    judged_at: '2026-11-20T06:00:00.000Z',
    ...over,
  }
}

const LAMBDA = deal(
  'Anthropic signs $35 billion computing deal with Nvidia-backed Lambda',
  'moneycontrol.com',
  '2026-09-01T18:15:00.000Z',
  { metric: 'commitment', amount: 35e9, amount_text: '$35 billion', counterparty: 'Lambda' },
)
const GOOGLE_121 = deal(
  'Should You Buy Alphabet Stock After Anthropic Raised Its Google Commitment to $121 Billion?',
  'fool.com',
  '2026-11-04T02:45:00.000Z',
  { metric: 'commitment', amount: 121e9, amount_text: '$121 Billion', counterparty: 'Google' },
)
const TOTAL_600 = deal(
  'Anthropic Has Locked In Over $600 Billion of Computing, More Than Intel Is Worth. It Still Wants More and That’s Big News for AMD.',
  '247wallst.com',
  '2026-10-21T16:00:00.000Z',
  { metric: 'commitment_total', amount: 600e9, amount_text: '$600 Billion' },
)
const AMAZON_BET = deal(
  'Amazon’s $18 Billion Anthropic Bet Is Worth $159 Billion at the IPO Price. Here’s What That Is Per Amazon Share',
  '247wallst.com',
  '2026-11-19T04:00:00.000Z',
  { metric: 'investment', amount: 18e9, amount_text: '$18 Billion', counterparty: 'Amazon' },
)
const BROADCOM = deal(
  'Broadcom offers Anthropic up to $42 billion in financing',
  'oklahomastar.com',
  '2026-10-05T03:45:00.000Z',
  {
    metric: 'financing',
    basis: 'sought',
    amount: 42e9,
    amount_text: '$42 billion',
    counterparty: 'Broadcom',
    outlets: 65,
  },
)

/** A real filed_facts row, first filing of its period. */
function filed(
  ticker: 'AMZN' | 'MSFT',
  concept: string,
  dims: string,
  start: string | null,
  end: string,
  value: number,
  filedOn: string,
  accession_no: string,
  doc: string,
): StoredFact {
  const cik = ticker === 'AMZN' ? AMZN : MSFT
  return {
    ticker,
    cik,
    concept,
    dims,
    start,
    end,
    value,
    unit: 'USD',
    form: '10-Q',
    filed: filedOn,
    accession_no,
    source_url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession_no.replace(/-/g, '')}/${doc}`,
    fetched_at: NOW,
  }
}

const ADDED = 'amzn:RevenueRemainingPerformanceObligationAmountPeriodIncreaseDecrease'
const CREDIT = 'us-gaap:LineOfCreditFacilityMaximumBorrowingCapacity'
const BACKLOG = 'us-gaap:RevenueRemainingPerformanceObligation'
const FUNDING = 'msft:EquityMethodInvestmentsTotalFundingCommitments'
const TIMING =
  'us-gaap:RevenueRemainingPerformanceObligationExpectedTimingOfSatisfactionStartDateAxis'
const CREDIT_DIMS =
  'dei:LegalEntityAxis=amzn:AnthropicMember;us-gaap:ShortTermDebtTypeAxis=us-gaap:LineOfCreditMember'
const MSFT_DIMS =
  'srt:ScheduleOfEquityMethodInvestmentEquityMethodInvesteeNameAxis=msft:OpenAIGlobalLlcMember'

const DEAL_FACTS: StoredFact[] = [
  filed(
    'AMZN',
    CREDIT,
    `${CREDIT_DIMS};us-gaap:SubsequentEventTypeAxis=us-gaap:SubsequentEventMember`,
    null,
    '2026-04-29',
    20e9,
    '2026-04-30',
    '0001018724-26-000014',
    'amzn-20260331_htm.xml',
  ),
  filed(
    'AMZN',
    BACKLOG,
    `srt:MajorCustomersAxis=amzn:OpenAIGroupPBCMember;${TIMING}=2026-04-01`,
    null,
    '2026-03-31',
    38e9,
    '2026-04-30',
    '0001018724-26-000014',
    'amzn-20260331_htm.xml',
  ),
  filed(
    'AMZN',
    CREDIT,
    CREDIT_DIMS,
    null,
    '2026-06-30',
    20e9,
    '2026-07-31',
    '0001018724-26-000026',
    'amzn-20260630_htm.xml',
  ),
  filed(
    'AMZN',
    ADDED,
    `srt:MajorCustomersAxis=amzn:AnthropicMember;${TIMING}=2026-07-01`,
    '2026-04-01',
    '2026-06-30',
    100e9,
    '2026-07-31',
    '0001018724-26-000026',
    'amzn-20260630_htm.xml',
  ),
  // The next 10-Q prints the same quarter again. The first filing dates it.
  filed(
    'AMZN',
    ADDED,
    `srt:MajorCustomersAxis=amzn:AnthropicMember;${TIMING}=2026-10-01`,
    '2026-04-01',
    '2026-06-30',
    100e9,
    '2026-10-30',
    '0001018724-26-000040',
    'amzn-20260930_htm.xml',
  ),
  filed(
    'MSFT',
    FUNDING,
    MSFT_DIMS,
    null,
    '2024-09-30',
    13e9,
    '2024-10-30',
    '0000950170-24-118967',
    'msft-20240930_htm.xml',
  ),
  filed(
    'MSFT',
    FUNDING,
    MSFT_DIMS,
    null,
    '2026-09-30',
    13e9,
    '2026-10-28',
    '0001193125-26-436133',
    'msft-20260930_htm.xml',
  ),
]

/** Anthropic's aggregate obligations, as its S-1/A of 2026-11-02 and its 424B4 state them. */
const aggregate = (value: number, filedOn: string, form: string, accession_no: string) => ({
  lab: 'anthropic' as const,
  value,
  filed: filedOn,
  form,
  accession_no,
  filing_url: `https://www.sec.gov/Archives/edgar/data/2130357/${accession_no.replace(/-/g, '')}/`,
  source_url: `https://www.sec.gov/Archives/edgar/data/2130357/${accession_no.replace(/-/g, '')}/doc.htm`,
  fetched_at: NOW,
})
const AGGREGATES: FiledAggregate[] = [
  aggregate(895.4e9, '2026-11-02', 'S-1/A', '0001628280-26-068676'),
  aggregate(900.9e9, '2026-11-19', '424B4', '0001628280-26-074944'),
]

const CTX = { facts: DEAL_FACTS, aggregates: AGGREGATES, tolerance_pct: TOLERANCE }
const score = (d: StoredDeal) => scoreDeal(d, CTX)

describe('the other company', () => {
  it('is a filer we read only under a name on the list', () => {
    expect(filerOf('Amazon')).toBe('AMZN')
    expect(filerOf('AWS')).toBe('AMZN')
    expect(filerOf('Google Cloud')).toBe('GOOGL')
    expect(filerOf(' Microsoft ')).toBe('MSFT')
    expect(filerOf('Lambda')).toBeNull()
    expect(filerOf('Nvidia')).toBeNull()
    expect(filerOf(null)).toBeNull()
  })
})

describe('scoring a deal report', () => {
  it('never scores a deal with a company whose filings we don’t read', () => {
    expect(score(LAMBDA)).toMatchObject({
      state: 'unsettled',
      reason: 'no-filer',
      why: 'We don’t read Lambda’s filings. We read Microsoft, Alphabet, Amazon, Meta, and Oracle.',
      filed: null,
      error_pct: null,
    })
  })

  it('says so when the filer tags no figure for the lab', () => {
    expect(score(GOOGLE_121)).toMatchObject({
      state: 'unsettled',
      reason: 'not-filed',
      why: 'Alphabet’s filings state no contract figure that names Anthropic.',
    })
    // Made up: Oracle files nothing on OpenAI by name.
    const oracle = deal('OpenAI signs $300 billion Oracle deal', 'example.com', NOW, {
      lab: 'openai',
      metric: 'commitment',
      amount: 300e9,
      amount_text: '$300 billion',
      counterparty: 'Oracle',
    })
    expect(score(oracle)).toMatchObject({
      reason: 'not-filed',
      why: 'Oracle’s filings state no contract figure that names OpenAI.',
    })
  })

  it('never holds a deal to a filed figure that measures something else', () => {
    expect(score(AMAZON_BET)).toMatchObject({
      state: 'unsettled',
      reason: 'different-measure',
      why: 'Amazon files the Anthropic shares it holds and its gains on them. It files no dollar amount invested.',
    })
    // Made up. $38 billion is also the backlog Amazon filed, and it still isn't scored against it.
    const openai = deal(
      'OpenAI signs $38 billion AWS deal',
      'example.com',
      '2026-03-01T12:00:00.000Z',
      {
        lab: 'openai',
        metric: 'commitment',
        amount: 38e9,
        amount_text: '$38 billion',
        counterparty: 'AWS',
      },
    )
    expect(score(openai)).toMatchObject({ state: 'unsettled', reason: 'different-measure' })
    expect(score(openai).why).toContain('falls as Amazon delivers')
    expect(score({ ...LAMBDA, currency: 'EUR', counterparty: 'Amazon' })).toMatchObject({
      state: 'unsettled',
      reason: 'different-measure',
    })
  })

  it('holds a count of all commitments to the next prospectus filing', () => {
    const r = score(TOTAL_600)
    expect(r).toMatchObject({
      state: 'missed',
      lead_days: 12,
      // Read back from GDELT's archive after the filing.
      held_before_filing: false,
      filed: {
        filer: 'Anthropic',
        ticker: null,
        value: 895.4e9,
        first_filed: '2026-11-02',
        form: 'S-1/A',
        period: 'filed 2026-11-02',
      },
    })
    expect(r.error_pct).toBeCloseTo(-32.99, 2)
    expect(r).not.toHaveProperty('judged_at')
    // A lab that hasn't filed has nothing to hold it to.
    expect(score({ ...TOTAL_600, lab: 'openai' })).toMatchObject({
      state: 'unsettled',
      reason: 'not-filed',
      why: 'OpenAI hasn’t filed its obligations with the SEC.',
    })
  })

  // Reading began 2026-09-01, after Amazon first filed each of its Anthropic
  // figures, so no stored headline can be scored against them. These are made up.
  const aws = (published_at: string, amount: number, over: Partial<StoredDeal> = {}) =>
    deal(`Anthropic commits $${amount / 1e9} billion to AWS`, 'example.com', published_at, {
      metric: 'commitment',
      amount,
      amount_text: `$${amount / 1e9} billion`,
      counterparty: 'AWS',
      ...over,
    })

  it('scores a contract against what the filer added in the quarter of the report', () => {
    expect(score(aws('2026-05-10T12:00:00.000Z', 100e9))).toMatchObject({
      state: 'matched',
      error_pct: 0,
      lead_days: 82,
      held_before_filing: false,
      filed: {
        filer: 'Amazon',
        ticker: 'AMZN',
        period: 'Q2 2026',
        value: 100e9,
        first_filed: '2026-07-31',
        accession_no: '0001018724-26-000026',
        filing_url: 'https://www.sec.gov/Archives/edgar/data/1018724/000101872426000026/',
      },
    })
    const high = score(
      aws('2026-05-10T12:00:00.000Z', 125e9, { found_at: '2026-05-10T13:00:00.000Z' }),
    )
    expect(high).toMatchObject({ state: 'missed', error_pct: 25, held_before_filing: true })
    // Published after the quarter ended and before its 10-Q: held to it only within tolerance.
    expect(score(aws('2026-07-10T12:00:00.000Z', 102e9))).toMatchObject({
      state: 'matched',
      lead_days: 21,
    })
    expect(score(aws('2026-07-10T12:00:00.000Z', 60e9))).toMatchObject({
      state: 'open',
      filed: null,
    })
  })

  it('never scores a report from the filing day on', () => {
    expect(score(aws('2026-07-31T15:00:00.000Z', 100e9))).toMatchObject({
      state: 'restated',
      error_pct: 0,
      lead_days: null,
      held_before_filing: null,
      filed: { first_filed: '2026-07-31' },
    })
    // A new amount after the filing waits for a quarter not filed yet.
    expect(score(aws('2026-11-10T12:00:00.000Z', 50e9))).toMatchObject({
      state: 'open',
      filed: null,
    })
  })

  it('scores a credit line or a funding commitment against the next balance filed', () => {
    const loan = deal(
      'Amazon to lend Anthropic $20 billion',
      'example.com',
      '2026-04-20T12:00:00.000Z',
      {
        metric: 'financing',
        amount: 20e9,
        amount_text: '$20 billion',
        counterparty: 'Amazon',
      },
    )
    expect(score(loan)).toMatchObject({
      state: 'matched',
      lead_days: 10,
      filed: { period: 'at 2026-04-29', first_filed: '2026-04-30' },
    })
    const msft = deal(
      'Microsoft has put $13 billion into OpenAI',
      'example.com',
      '2026-09-15T12:00:00.000Z',
      {
        lab: 'openai',
        metric: 'investment',
        amount: 13e9,
        amount_text: '$13 billion',
        counterparty: 'Microsoft',
      },
    )
    // Filed every quarter since 2024: by 2026 the headline repeats it.
    expect(score(msft)).toMatchObject({ state: 'restated', filed: { first_filed: '2024-10-30' } })
    expect(score({ ...msft, amount: 20e9 })).toMatchObject({
      state: 'missed',
      filed: { period: 'at 2026-09-30', first_filed: '2026-10-28' },
    })
  })

  it('leaves out what a headline says is offered or in talks, and tallies the rest', () => {
    const all = scoreDeals([LAMBDA, GOOGLE_121, TOTAL_600, AMAZON_BET, BROADCOM], CTX)
    expect(all.map((d) => [d.title.slice(0, 20), d.state])).toEqual([
      ['Amazon’s $18 Billion', 'unsettled'],
      ['Should You Buy Alpha', 'unsettled'],
      ['Anthropic Has Locked', 'missed'],
      ['Anthropic signs $35 ', 'unsettled'],
    ])
    expect(dealTally(all)).toMatchObject({
      reports: 4,
      scored: 1,
      missed: 1,
      restated: 0,
      open: 0,
      unsettled: 3,
      held: 0,
    })
    expect(dealTally([]).median_abs_error_pct).toBeNull()
  })
})

// ---- the judge's deal labels ----------------------------------------------

describe('labeling deals', () => {
  const figure = (over: Partial<JudgeFigure>): JudgeFigure => ({
    lab: 'anthropic',
    metric: 'commitment',
    basis: 'reported',
    amount: '$35 billion',
    period: null,
    counterparty: 'Lambda',
    ...over,
  })
  const HASH = (n: number) => n.toString(16).padStart(64, '0')

  beforeEach(async () => {
    await db.delete(schema.reportedFigures)
    await db.delete(schema.reportedReviews)
    await db.delete(schema.reportedArticles)
  })

  async function article(n: number, title: string, published_at: string) {
    const title_key = title.toLowerCase()
    await db.insert(schema.reportedArticles).values({
      id: HASH(n),
      title_key,
      title,
      outlet: 'example.com',
      url: `https://example.com/${n}`,
      published_at,
      found_at: FOUND,
      record_id: `r${n}`,
      source_url: `https://example.com/${n}`,
      fetched_at: FOUND,
    })
    return title_key
  }

  /** A headline the judge read before deal sizes were labeled. */
  const readBefore = (title_key: string) =>
    db.insert(schema.reportedReviews).values({
      id: reviewId(title_key),
      title_key,
      figures: 0,
      judged_at: '2026-11-08T06:00:00.000Z',
    })

  it('keeps a headline for a deal word alone', () => {
    expect(figureHeadline(LAMBDA.title)).toMatchObject({ labs: ['anthropic'] })
    expect(figureHeadline(BROADCOM.title)).not.toBeNull()
    expect(figureHeadline('Anthropic opens a $40 million office')).toBeNull()
  })

  it('holds a deal label only when the other company is in the headline as written', () => {
    expect(figureFailure(LAMBDA.title, figure({}))).toBeNull()
    expect(figureFailure(LAMBDA.title, figure({ counterparty: 'Nvidia-backed Lambda' }))).toBeNull()
    expect(figureFailure(LAMBDA.title, figure({ counterparty: 'Oracle' }))).toEqual({
      reason: 'counterparty-not-in-headline',
      detail: 'Oracle',
    })
    expect(figureFailure(LAMBDA.title, figure({ counterparty: null }))?.reason).toBe(
      'counterparty-not-in-headline',
    )
    expect(figureFailure(LAMBDA.title, figure({ counterparty: 'Anthropic' }))?.reason).toBe(
      'counterparty-is-the-lab',
    )
    // The lab's commitments to everyone name no one company.
    expect(
      figureFailure(
        TOTAL_600.title,
        figure({ metric: 'commitment_total', amount: '$600 Billion', counterparty: null }),
      ),
    ).toBeNull()
  })

  it('reads a headline with a deal word a second time, for its deals only', async () => {
    const lambda = await article(1, LAMBDA.title, LAMBDA.published_at)
    // Made up: no deal word, so one reading was enough.
    const plain = await article(2, 'Anthropic revenue hits $5 billion', '2026-09-02T00:00:00.000Z')
    await readBefore(lambda)
    await readBefore(plain)
    const unread = await article(3, BROADCOM.title, BROADCOM.published_at)

    // The unread headline first, then the one owed a deal reading.
    expect((await figureReview(db)).map((r) => r.article_id)).toEqual([HASH(3), HASH(1)])

    const at = new Date('2026-11-20T06:00:00Z')
    const report = await applyFigureReadings(
      db,
      [
        {
          article_id: HASH(1),
          figures: [
            figure({}),
            // The first reading decided this headline's funding. A second can't add one.
            figure({ metric: 'funding', counterparty: null }),
          ],
        },
        { article_id: HASH(2), figures: [figure({ metric: 'revenue', amount: '$5 billion' })] },
        {
          article_id: HASH(3),
          figures: [
            figure({
              metric: 'financing',
              basis: 'sought',
              amount: '$42 billion',
              counterparty: 'Broadcom',
            }),
          ],
        },
      ],
      at,
    )
    expect(report).toMatchObject({ accepted: 2, inserted: 2, rejected: [] })

    const stored = await db.select().from(schema.reportedFigures)
    expect(
      stored
        .map((f) => [f.metric, f.counterparty, f.basis, f.amount])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['commitment', 'Lambda', 'reported', 35e9],
      ['financing', 'Broadcom', 'sought', 42e9],
    ])
    const [review] = await db
      .select()
      .from(schema.reportedReviews)
      .where(eq(schema.reportedReviews.title_key, lambda))
    expect(review).toMatchObject({
      judged_at: '2026-11-08T06:00:00.000Z',
      deals_at: '2026-11-20T06:00:00.000Z',
    })
    const [first] = await db
      .select()
      .from(schema.reportedReviews)
      .where(eq(schema.reportedReviews.title_key, unread))
    expect(first!.deals_at).toBe(first!.judged_at)

    // Nothing is offered or kept a third time.
    expect(await figureReview(db)).toEqual([])
    const again = await applyFigureReadings(
      db,
      [{ article_id: HASH(1), figures: [figure({ amount: '$35 billion', basis: 'sought' })] }],
      new Date('2026-11-21T06:00:00Z'),
    )
    expect(again).toMatchObject({ accepted: 0, inserted: 0 })
    expect(await db.select().from(schema.reportedFigures)).toHaveLength(2)
  })
})

// ---- the run and the payload ----------------------------------------------

const YAML = `cik_whitelist:
  META: "${META}"

filed_fact_sources:
  filed-facts-meta:
    ticker: META
    url: https://data.sec.gov/api/xbrl/companyfacts/CIK${META}.json
    instances: false
    rights: ours
`

const ok = (text: string): FetchOutcome => ({ ok: true, status: 200, text, bytes: text.length })
const missing: FetchOutcome = { ok: false, status: 404, detail: 'HTTP 404' }

/** Meta's feed with two results 8-Ks (one whose index page lists no release) and one 8-K without results. */
const RELEASE = '0001326801-25-000014'
const NO_EXHIBIT = '0001326801-24-000077'
const index = provenanceOf('guidance-meta-2025-01-29-index').source_url
const exhibit = provenanceOf('guidance-meta-2025-01-29').source_url
const bareIndex = `https://www.sec.gov/Archives/edgar/data/1326801/${NO_EXHIBIT.replace(/-/g, '')}/${NO_EXHIBIT}-index.html`

function world() {
  const docs: Record<string, FetchOutcome> = {
    [`https://data.sec.gov/submissions/CIK${META}.json`]: ok(
      JSON.stringify({
        cik: META,
        filings: {
          recent: {
            form: ['8-K', '8-K', '8-K'],
            accessionNumber: [RELEASE, '0001326801-25-000009', NO_EXHIBIT],
            filingDate: ['2025-01-29', '2025-01-10', '2024-10-30'],
            primaryDocument: ['meta-20250129.htm', 'x.htm', 'meta-20241030.htm'],
            items: ['2.02,9.01', '5.02', '2.02,9.01'],
          },
        },
      }),
    ),
    [`https://data.sec.gov/api/xbrl/companyfacts/CIK${META}.json`]: ok(
      fixtureText('fixtures/filed-facts/companyfacts-meta.json'),
    ),
    [index]: ok(fixtureText('fixtures/guidance/meta-2025-01-29-index.html')),
    [exhibit]: ok(fixtureText('fixtures/guidance/meta-2025-01-29-ex99-1.htm')),
    [bareIndex]: ok(`<html><body>${NO_EXHIBIT}<table><tr><td>8-K</td></tr></table></body></html>`),
  }
  const fetched: string[] = []
  const stored: string[] = []
  const fetcher = async (s: FetchSource) => {
    fetched.push(s.url)
    return docs[s.url] ?? missing
  }
  const bodies = new Map<string, string>()
  const raw = {
    put: async (key: string, body: string) => {
      stored.push(key)
      bodies.set(key, body)
    },
  }
  const readRaw = async (key: string) => bodies.get(key) ?? null
  return { docs, fetched, stored, bodies, fetcher, raw, readRaw }
}

describe('reading releases and serving both checks', () => {
  const sourcesYaml = fixtureText('sources.yaml')
  const ctx = (as_of: string | null = null) => queryContext(sourcesYaml, as_of, () => new Date(NOW))

  beforeEach(async () => {
    await db.delete(schema.filedGuidance)
    await db.delete(schema.filedFactReads)
    await db.delete(schema.filedFacts)
    await db.delete(schema.reportedFigures)
    await db.delete(schema.reportedReviews)
    await db.delete(schema.reportedArticles)
    await db.delete(schema.alerts)
    await db.delete(schema.changes)
  })

  it('stores a release’s guidance once, with its source, and raises no alert', async () => {
    const w = world()
    const run = await runFiledFacts(db, {
      ...w,
      now: new Date('2026-11-19T17:00:00Z'),
      sourcesYaml: YAML,
    })
    expect(run.alerts).toBe(0)
    expect(
      run.reads.filter((r) => r.kind === 'release').map((r) => [r.accession_no, r.status, r.facts]),
    ).toEqual([
      [RELEASE, 'ok', 1],
      [NO_EXHIBIT, 'ok', 0],
    ])
    const [bare] = await db
      .select()
      .from(schema.filedFactReads)
      .where(eq(schema.filedFactReads.accession_no, NO_EXHIBIT))
    expect(bare).toMatchObject({ kind: 'release', status: 'ok', detail: 'no exhibit 99.1' })
    // The 8-K with no results item is never fetched.
    expect(w.fetched.filter((u) => u.includes('000132680125000009'))).toEqual([])
    expect(w.stored).toContain(`guidance/meta/${RELEASE}.htm`)

    expect(await db.select().from(schema.filedGuidance)).toEqual([
      expect.objectContaining({
        ticker: 'META',
        cik: META,
        accession_no: RELEASE,
        filed: '2025-01-29',
        fiscal_year: 2025,
        low: 60e9,
        high: 65e9,
        source_url: exhibit,
        fetched_at: '2026-11-19T17:00:00.000Z',
        raw_key: `guidance/meta/${RELEASE}.htm`,
      }),
    ])

    // The next run has both releases and fetches neither again.
    w.fetched.length = 0
    const second = await runFiledFacts(db, {
      ...w,
      now: new Date('2026-11-19T17:30:00Z'),
      sourcesYaml: YAML,
    })
    expect(second.reads).toEqual([])
    expect(w.fetched.every((u) => u.includes('/submissions/'))).toBe(true)
    expect(await db.select().from(schema.alerts)).toEqual([])
  })

  it('serves guidance scored against the filed year, and rewinds it by filing date', async () => {
    await runFiledFacts(db, {
      ...world(),
      now: new Date('2026-11-19T17:00:00Z'),
      sourcesYaml: YAML,
    })

    const data = await queryGroundTruth(db, ctx())
    expect(data.guidance.since).toBe(GUIDANCE_SINCE)
    expect(data.guidance.tally).toMatchObject({ figures: 1, scored: 1, above: 1, met: 0 })
    expect(data.guidance.rows).toEqual([
      expect.objectContaining({
        ticker: 'META',
        filer: 'Meta',
        period: '2025',
        low: 60e9,
        high: 65e9,
        state: 'above',
        lead_days: 365,
        filed: '2025-01-29',
        source_url: exhibit,
        fetched_at: '2026-11-19T17:00:00.000Z',
        actual: expect.objectContaining({ value: 72_215_000_000, first_filed: '2026-01-29' }),
      }),
    ])
    expect(data.guidance.filers.find((f) => f.ticker === 'META')).toMatchObject({
      releases_read: 2,
      releases_with_figure: 1,
    })
    expect(data.guidance.filers.find((f) => f.ticker === 'MSFT')).toMatchObject({
      releases_read: 0,
      releases_with_figure: 0,
    })
  })

  it('serves each deal report with its result, and counts headlines still owed a reading', async () => {
    const HASH = (n: number) => n.toString(16).padStart(64, '0')
    const rows: [StoredDeal, string | null][] = [
      [LAMBDA, '2026-11-20T06:00:00.000Z'],
      [BROADCOM, null],
    ]
    for (const [i, [d, deals_at]] of rows.entries()) {
      const title_key = d.title.toLowerCase()
      await db.insert(schema.reportedArticles).values({
        id: HASH(i + 1),
        title_key,
        title: d.title,
        outlet: d.outlet,
        url: d.url,
        published_at: d.published_at,
        found_at: d.found_at,
        record_id: `r${i}`,
        source_url: d.url,
        fetched_at: d.fetched_at,
      })
      await db.insert(schema.reportedReviews).values({
        id: reviewId(title_key),
        title_key,
        figures: 0,
        judged_at: '2026-11-08T06:00:00.000Z',
        deals_at,
      })
    }
    await db.insert(schema.reportedFigures).values({
      id: HASH(100),
      title_key: LAMBDA.title.toLowerCase(),
      article_id: HASH(1),
      lab: 'anthropic',
      metric: 'commitment',
      basis: 'reported',
      counterparty: 'Lambda',
      currency: 'USD',
      amount: 35e9,
      amount_text: '$35 billion',
      period: null,
      published_at: LAMBDA.published_at,
      judged_at: '2026-11-19T06:00:00.000Z',
      source_url: LAMBDA.url,
      fetched_at: LAMBDA.fetched_at,
    })

    const data = await queryGroundTruth(db, ctx())
    expect(data.deals.reports).toEqual([
      expect.objectContaining({
        title: LAMBDA.title,
        outlet: 'moneycontrol.com',
        metric: 'commitment',
        counterparty: 'Lambda',
        amount: 35e9,
        state: 'unsettled',
        reason: 'no-filer',
        source_url: LAMBDA.url,
        fetched_at: FOUND,
      }),
    ])
    expect(data.deals.tally).toMatchObject({ reports: 1, scored: 0, unsettled: 1 })
    expect(data.deals.unread).toBe(1)
    expect(data.deals.first_labeled_at).toBe('2026-11-19T06:00:00.000Z')
    expect(data.deals.measures.map((m) => [m.lab, m.filer, m.metric, m.compares])).toEqual([
      ['anthropic', 'Amazon', 'commitment', 'added'],
      ['anthropic', 'Amazon', 'financing', 'total'],
      ['anthropic', 'Amazon', 'investment', null],
      ['openai', 'Amazon', 'commitment', null],
      ['openai', 'Microsoft', 'investment', 'total'],
      ['anthropic', 'Anthropic', 'commitment_total', 'total'],
    ])
    // A deal isn't the lab's own revenue, valuation or funding: the revenue check never sees it.
    expect(data).toMatchObject({ resolutions: [], open: [], waiting: [] })
  })

  it('is empty, not an error, before anything is stored', async () => {
    const data = await queryGroundTruth(db, ctx())
    expect(data.deals).toMatchObject({
      reports: [],
      unread: 0,
      first_labeled_at: null,
      tally: { reports: 0, scored: 0, median_abs_error_pct: null },
    })
    expect(data.guidance).toMatchObject({
      rows: [],
      tally: { figures: 0, scored: 0, median_miss_pct: null },
    })
    expect(data.guidance.filers).toHaveLength(5)
  })
})
