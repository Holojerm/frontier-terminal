import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vitest'

import type { ExposurePoint, ExposureSeries } from '../shared/utils/terminal-exposure'

import * as schema from '~~/server/db/schema'
import { filedFactAlert, headlineFor } from '../server/exposure/alerts'
import {
  extractCompanyfacts,
  extractInstanceFacts,
  instanceDocuments,
} from '../server/exposure/facts'
import { filerFacts, runFiledFacts } from '../server/exposure/ingest'
import {
  buildSeries,
  earlierPoints,
  isAlerting,
  quarterly,
  type StoredFact,
} from '../server/exposure/series'
import type { FetchOutcome, FetchSource } from '../server/pipeline/fetch'
import { queryContext } from '../server/utils/terminal-db'
import { EXPORT_TABLES } from '../server/utils/terminal-export'
import { collect, csvChunks } from '../server/utils/terminal-export-format'
import { queryExposure } from '../server/utils/terminal-exposure'
import { readFiledFactSources } from '../server/utils/terminal-sources'
import { parseCikWhitelistBlock } from '../server/pipeline/parsers/sec/whitelist'
import { fixtureText } from './pipeline/fixtures'

// The hyperscaler filed facts: the two readers on trimmed EDGAR documents,
// the quarterly series and their restatements, the run's fetch policy and its
// quiet first read, the alert a new filing raises, and as_of by filing date.

const db = drizzle(env.DB, { schema })
const MSFT = '0000789019'
const AMZN = '0001018724'
const MSFT_Q = '0001193125-26-436133'
const NONOP = 'us-gaap:NonoperatingIncomeExpense'
const MARKS =
  'us-gaap:EquitySecuritiesWithoutReadilyDeterminableFairValueUpwardPriceAdjustmentAnnualAmount'
const AMZN_Q = '0001018724-26-000040'
const OPENAI = 'msft:OpenAIGlobalLlcMember'
const ANTHROPIC = 'amzn:AnthropicMember'

describe('extractCompanyfacts', () => {
  it('reads every capex, lease and backlog fact with its accession', () => {
    const facts = extractCompanyfacts(
      fixtureText('fixtures/filed-facts/companyfacts-msft.json'),
      MSFT,
    )
    const capex = facts.filter(
      (f) => f.concept === 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment',
    )
    expect(capex.length).toBeGreaterThan(10)
    expect(capex.find((f) => f.start === '2026-07-01' && f.end === '2026-09-30')).toMatchObject({
      value: 39_367_000_000,
      accession_no: MSFT_Q,
      form: '10-Q',
      dims: '',
    })
    expect(facts.some((f) => f.concept === 'us-gaap:RevenueRemainingPerformanceObligation')).toBe(
      true,
    )
  })

  it('refuses another filer’s document', () => {
    expect(() =>
      extractCompanyfacts(fixtureText('fixtures/filed-facts/companyfacts-msft.json'), AMZN),
    ).toThrow('company facts are for CIK')
  })
})

describe('extractInstanceFacts', () => {
  const filing = (cik: string, accession_no: string) => ({
    cik,
    form: '10-Q',
    filed: '2026-10-30',
    accession_no,
  })

  it('reads Microsoft’s facts on OpenAI and its commercial backlog', () => {
    const facts = extractInstanceFacts(
      fixtureText('fixtures/filed-facts/msft-20260930.xml'),
      filing(MSFT, MSFT_Q),
      [OPENAI],
    )
    const loss = facts.filter((f) => f.concept === 'us-gaap:NonoperatingIncomeExpense')
    expect(loss.map((f) => [f.end, f.value]).sort()).toEqual([
      ['2025-09-30', -4_100_000_000],
      ['2026-09-30', 272_000_000],
    ])
    expect(
      facts.find((f) => f.dims === 'srt:MajorCustomersAxis=msft:CommercialCustomersMember'),
    ).toMatchObject({ value: 677_000_000_000, unit: 'USD', start: null })
    expect(
      facts.find((f) => f.concept === 'us-gaap:EquityMethodInvestmentOwnershipPercentage'),
    ).toMatchObject({ value: 0.24, unit: 'pure' })
  })

  it('keeps Amazon’s typed timing axis, so its total backlog is readable', () => {
    const facts = extractInstanceFacts(
      fixtureText('fixtures/filed-facts/amzn-20260930.xml'),
      filing(AMZN, AMZN_Q),
      [ANTHROPIC],
    )
    expect(
      facts.find(
        (f) =>
          f.dims ===
          'us-gaap:RevenueRemainingPerformanceObligationExpectedTimingOfSatisfactionStartDateAxis=2026-10-01',
      ),
    ).toMatchObject({ value: 578_000_000_000, end: '2026-09-30' })
    expect(facts.find((f) => f.concept === 'us-gaap:InvestmentOwnedBalanceShares')).toMatchObject({
      value: 164_000_000,
      unit: 'shares',
    })
  })

  it('refuses an instance that names another filing', () => {
    const xml = fixtureText('fixtures/filed-facts/amzn-20260930.xml')
    expect(() => extractInstanceFacts(xml, filing(MSFT, 'x'), [])).toThrow('instance names CIK')
    expect(() => extractInstanceFacts(xml, { ...filing(AMZN, 'x'), form: '10-K' }, [])).toThrow(
      'instance is a 10-Q, not a 10-K',
    )
  })
})

describe('instanceDocuments', () => {
  it('lists original 10-Q/10-K since a date, newest first, named after the primary document', () => {
    const docs = instanceDocuments(
      fixtureText('fixtures/sec/edgar-submissions-msft.json'),
      MSFT,
      '2020-01-01',
    )
    expect(docs.length).toBeGreaterThan(0)
    for (const d of docs) {
      expect(['10-Q', '10-K']).toContain(d.form)
      expect(d.url).toMatch(
        /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/789019\/\d{18}\/.+_htm\.xml$/,
      )
    }
    expect([...docs].sort((a, b) => (a.filed < b.filed ? 1 : -1))).toEqual(docs)
  })
})

const fact = (over: Partial<StoredFact>): StoredFact => ({
  ticker: 'GOOGL',
  concept: 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment',
  dims: '',
  start: null,
  end: '2026-03-31',
  value: 0,
  unit: 'USD',
  form: '10-Q',
  filed: '2026-04-30',
  accession_no: 'a1',
  cik: '0001652044',
  source_url: 'https://example.test/cf.json',
  fetched_at: '2026-11-04T00:00:00.000Z',
  ...over,
})

describe('quarterly', () => {
  it('reads three-month facts and derives the rest from year-to-date pairs', () => {
    const facts = [
      fact({ start: '2026-01-01', end: '2026-03-31', value: 30, accession_no: 'q1' }),
      fact({
        start: '2026-01-01',
        end: '2026-06-30',
        value: 70,
        accession_no: 'q2',
        filed: '2026-07-30',
      }),
      fact({
        start: '2026-01-01',
        end: '2026-09-30',
        value: 120,
        accession_no: 'q3',
        filed: '2026-10-30',
      }),
    ]
    const points = quarterly(new Map(facts.map((f) => [`${f.start}|${f.end}`, f])))
    expect(points.map((p) => [p.start, p.end, p.value, p.derived])).toEqual([
      ['2026-01-01', '2026-03-31', 30, false],
      ['2026-04-01', '2026-06-30', 40, true],
      ['2026-07-01', '2026-09-30', 50, true],
    ])
    expect(points[2]!.less).toMatchObject({ accession_no: 'q2', value: 70 })
    expect(points[2]!.accession_no).toBe('q3')
  })

  it('keeps a restated value as superseded and shows the newest filing’s', () => {
    const series = buildSeries([
      fact({ start: '2026-01-01', end: '2026-03-31', value: 30, accession_no: 'old' }),
      fact({
        start: '2026-01-01',
        end: '2026-03-31',
        value: 31,
        accession_no: 'new',
        filed: '2026-07-30',
      }),
      fact({
        start: '2026-01-01',
        end: '2026-03-31',
        value: 31,
        accession_no: 'again',
        filed: '2026-07-01',
      }),
    ]).find((s) => s.id === 'googl-capex')!
    expect(series.points).toHaveLength(1)
    expect(series.points[0]).toMatchObject({ value: 31, accession_no: 'new' })
    expect(series.superseded).toEqual([
      expect.objectContaining({ value: 30, accession_no: 'old', replaced_by: 'new' }),
    ])
  })
})

describe('headlineFor', () => {
  const s = (group: ExposureSeries['group'], filer: string, id = 'x', concept = '', unit = 'USD') =>
    ({ id, group, filer, concept, unit, label: 'Some line' }) as ExposureSeries
  const p = (value: number, end = '2026-09-30', months: number | null = 3) =>
    ({ value, end, months }) as ExposurePoint

  it('states the number', () => {
    expect(headlineFor(s('capex', 'Microsoft'), p(39.4e9), p(34.9e9))).toBe(
      'Microsoft’s capex hits $39.4B in the quarter to 2026-09-30, up from $34.9B',
    )
    expect(
      headlineFor(
        s('rpo', 'Oracle', 'orcl-rpo'),
        p(455e9, '2026-08-31', null),
        p(664e9, '2026-05-31', null),
      ),
    ).toBe('Oracle’s backlog falls to $455B at 2026-08-31, from $664B')
    expect(
      headlineFor(s('rpo', 'Alphabet', 'googl-rpo-cloud'), p(560.8e9, '2026-09-30', null), null),
    ).toBe('Alphabet’s Google Cloud backlog reaches $561B at 2026-09-30')
    expect(headlineFor(s('openai', 'Microsoft', 'x', NONOP), p(-4.1e9), null)).toBe(
      'Microsoft books a $4.10B loss on OpenAI in the quarter to 2026-09-30',
    )
    expect(headlineFor(s('anthropic', 'Amazon', 'x', MARKS), p(55.6e9), null)).toBe(
      'Amazon marks its Anthropic stake up by $55.6B in the quarter to 2026-09-30',
    )
    expect(
      headlineFor(s('anthropic', 'Amazon', 'x', MARKS), p(62.8e9, '2026-09-30', 9), null),
    ).toBe('Amazon marks its Anthropic stake up by $62.8B in the nine months to 2026-09-30')
  })

  it('has a line for each lab commitment and claim', () => {
    const msft = (concept: string, unit = 'USD') => s('openai', 'Microsoft', 'x', concept, unit)
    const amzn = (concept: string) => s('anthropic', 'Amazon', 'x', concept)
    const at = (v: number, end = '2026-09-30') => p(v, end, null)
    expect(
      headlineFor(msft('msft:EquityMethodInvestmentsTotalFundingCommitments'), at(13e9), null),
    ).toBe('Microsoft’s funding commitment to OpenAI reaches $13.0B at 2026-09-30')
    expect(
      headlineFor(msft('msft:EquityMethodInvestmentsFunded'), at(12e9), at(11e9, '2026-06-30')),
    ).toBe('Microsoft’s funding paid in to OpenAI reaches $12.0B at 2026-09-30, up from $11.0B')
    expect(
      headlineFor(msft('us-gaap:AccountsReceivableNet'), at(7.2e9), at(6e9, '2026-06-30')),
    ).toBe('Microsoft’s receivables from OpenAI reach $7.20B at 2026-09-30, up from $6.00B')
    expect(
      headlineFor(
        msft('us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax'),
        p(10e9),
        null,
      ),
    ).toBe('Microsoft’s revenue from OpenAI hits $10.0B in the quarter to 2026-09-30')
    const stake = msft('us-gaap:EquityMethodInvestmentOwnershipPercentage', 'pure')
    expect(headlineFor(stake, at(0.24), null)).toBe(
      'Microsoft reports a 24% stake in OpenAI at 2026-09-30',
    )
    expect(headlineFor(stake, at(0.18), at(0.24, '2026-06-30'))).toBe(
      'Microsoft’s stake in OpenAI falls to 18% at 2026-09-30, from 24%',
    )
    expect(
      headlineFor(
        amzn('us-gaap:LineOfCreditFacilityMaximumBorrowingCapacity'),
        at(20e9, '2026-06-30'),
        null,
      ),
    ).toBe('Amazon’s financing line to Anthropic reaches $20.0B at 2026-06-30')
    expect(
      headlineFor(
        amzn('us-gaap:LineOfCreditFacilityCurrentBorrowingCapacity'),
        at(10e9),
        at(15e9, '2026-06-30'),
      ),
    ).toBe('Amazon’s financing available to Anthropic falls to $10.0B at 2026-09-30, from $15.0B')
    const added = amzn('amzn:RevenueRemainingPerformanceObligationAmountPeriodIncreaseDecrease')
    expect(headlineFor(added, p(100e9, '2026-06-30'), null)).toBe(
      'Amazon adds $100B from Anthropic to its backlog in the quarter to 2026-06-30',
    )
    expect(headlineFor(added, p(-5e9), null)).toBe(
      'Amazon’s backlog from Anthropic falls by $5.00B in the quarter to 2026-09-30',
    )
  })

  it('says a lab backlog falls to a figure, never that it was cut', () => {
    const openai = headlineFor(
      s('rpo', 'Amazon', 'amzn-rpo-openai'),
      p(30e9, '2026-09-30', null),
      p(38e9, '2026-03-31', null),
    )
    expect(openai).toBe('Amazon’s backlog from OpenAI falls to $30.0B at 2026-09-30, from $38.0B')
    const crux = headlineFor(
      s('rpo', 'Alphabet', 'googl-rpo-investee'),
      p(16.8e9, '2026-09-30', null),
      null,
    )
    expect(crux).toBe('Alphabet’s backlog from Crux AI reaches $16.8B at 2026-09-30')
    for (const h of [openai, crux]) expect(h).not.toMatch(/cut|cancel/i)
  })
})

// ---- the run --------------------------------------------------------------

const YAML = `cik_whitelist:
  MSFT: "${MSFT}"
  AMZN: "${AMZN}"

filed_fact_sources:
  filed-facts-msft:
    ticker: MSFT
    url: https://data.sec.gov/api/xbrl/companyfacts/CIK${MSFT}.json
    instances: true
    rights: ours
  filed-facts-amzn:
    ticker: AMZN
    url: https://data.sec.gov/api/xbrl/companyfacts/CIK${AMZN}.json
    instances: true
    rights: ours
`

const submissions = (cik: string, rows: [string, string, string, string][]) =>
  JSON.stringify({
    cik,
    filings: {
      recent: {
        form: rows.map((r) => r[0]),
        accessionNumber: rows.map((r) => r[1]),
        filingDate: rows.map((r) => r[2]),
        primaryDocument: rows.map((r) => r[3]),
      },
    },
  })

const ok = (text: string): FetchOutcome => ({ ok: true, status: 200, text, bytes: text.length })
const missing: FetchOutcome = { ok: false, status: 404, detail: 'HTTP 404' }

function world() {
  const docs: Record<string, FetchOutcome> = {
    [`https://data.sec.gov/submissions/CIK${MSFT}.json`]: ok(
      submissions(MSFT, [
        ['10-Q', MSFT_Q, '2026-10-28', 'msft-20260930.htm'],
        ['8-K', '0001193125-26-000001', '2026-10-28', 'x.htm'],
      ]),
    ),
    [`https://data.sec.gov/submissions/CIK${AMZN}.json`]: ok(
      submissions(AMZN, [['10-Q', AMZN_Q, '2026-10-30', 'amzn-20260930.htm']]),
    ),
    [`https://data.sec.gov/api/xbrl/companyfacts/CIK${MSFT}.json`]: ok(
      fixtureText('fixtures/filed-facts/companyfacts-msft.json'),
    ),
    [`https://data.sec.gov/api/xbrl/companyfacts/CIK${AMZN}.json`]: ok(
      fixtureText('fixtures/filed-facts/companyfacts-amzn.json'),
    ),
    'https://www.sec.gov/Archives/edgar/data/789019/000119312526436133/msft-20260930_htm.xml': ok(
      fixtureText('fixtures/filed-facts/msft-20260930.xml'),
    ),
    'https://www.sec.gov/Archives/edgar/data/1018724/000101872426000040/amzn-20260930_htm.xml': ok(
      fixtureText('fixtures/filed-facts/amzn-20260930.xml'),
    ),
  }
  const fetched: string[] = []
  const stored: string[] = []
  const fetcher = async (s: FetchSource) => {
    fetched.push(s.url)
    return docs[s.url] ?? missing
  }
  const raw = { put: async (key: string) => void stored.push(key) }
  return { docs, fetched, stored, fetcher, raw }
}

describe('runFiledFacts', () => {
  it('back-fills quietly, re-reads nothing it holds, and alerts on the next filing with its number', async () => {
    const w = world()
    const first = await runFiledFacts(db, {
      ...w,
      now: new Date('2026-11-04T17:00:00Z'),
      sourcesYaml: YAML,
    })
    expect(first.alerts).toBe(0)
    expect(first.reads.filter((r) => r.status !== 'ok')).toEqual([])
    expect(first.reads.filter((r) => r.kind === 'instance')).toHaveLength(2)
    expect(w.stored).toContain(`filed-facts/msft/${MSFT_Q}.xml`)
    const msft = await filerFacts(db, 'MSFT')
    expect(msft.some((f) => f.concept === 'us-gaap:NonoperatingIncomeExpense')).toBe(true)

    // Thirty minutes later: company facts aren't due and the instances are read.
    w.fetched.length = 0
    const second = await runFiledFacts(db, {
      ...w,
      now: new Date('2026-11-04T17:30:00Z'),
      sourcesYaml: YAML,
    })
    expect(second.reads).toEqual([])
    expect(w.fetched.every((u) => u.includes('/submissions/'))).toBe(true)

    // Microsoft files its next 10-Q; company facts carry its six months.
    const next = '0001193125-27-000100'
    const cf = JSON.parse(fixtureText('fixtures/filed-facts/companyfacts-msft.json'))
    cf.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment.units.USD.push({
      start: '2026-07-01',
      end: '2026-12-31',
      val: 84_367_000_000,
      accn: next,
      fy: 2027,
      fp: 'Q2',
      form: '10-Q',
      filed: '2027-01-27',
    })
    w.docs[`https://data.sec.gov/api/xbrl/companyfacts/CIK${MSFT}.json`] = ok(JSON.stringify(cf))
    w.docs[`https://data.sec.gov/submissions/CIK${MSFT}.json`] = ok(
      submissions(MSFT, [
        ['10-Q', next, '2027-01-27', 'msft-20261231.htm'],
        ['10-Q', MSFT_Q, '2026-10-28', 'msft-20260930.htm'],
      ]),
    )
    const third = await runFiledFacts(db, {
      ...w,
      now: new Date('2027-01-28T12:00:00Z'),
      sourcesYaml: YAML,
    })
    // The new instance 404s: a failed read, retried tomorrow, the run goes on.
    expect(third.reads).toContainEqual(
      expect.objectContaining({ kind: 'instance', accession_no: next, status: 'failed' }),
    )
    expect(third.alerts).toBe(1)
    const [alert] = await db.select().from(schema.alerts)
    expect(alert!.headline).toBe(
      'Microsoft’s capex hits $45.0B in the quarter to 2026-12-31, up from $39.4B',
    )
    expect(alert!.rule).toBe('filed-fact-floor')
    const [change] = await db.select().from(schema.changes)
    expect(JSON.parse(alert!.change_ids)).toEqual([change!.id])
    expect(JSON.parse(change!.after_json!)).toMatchObject({
      series_id: 'msft-capex',
      value: 45_000_000_000,
      derived: true,
      accession_no: next,
    })

    // Run again: nothing new is written.
    const fourth = await runFiledFacts(db, {
      ...w,
      now: new Date('2027-01-28T12:30:00Z'),
      sourcesYaml: YAML,
    })
    expect(fourth.alerts).toBe(0)
    expect(await db.select().from(schema.alerts)).toHaveLength(1)

    // As of a day: only what was filed before it.
    const sourcesYaml = fixtureText('sources.yaml')
    const live = await queryExposure(db, queryContext(sourcesYaml, null))
    const before = await queryExposure(
      db,
      queryContext(sourcesYaml, null, undefined, '2026-10-29T12:00:00.000Z'),
    )
    const last = (data: typeof live, id: string) =>
      data.series.find((s) => s.id === id)?.points.at(-1)
    expect(last(live, 'msft-capex')!.end).toBe('2026-12-31')
    expect(last(before, 'msft-capex')!.end).toBe('2026-09-30')
    expect(last(live, 'amzn-rpo')!.end).toBe('2026-09-30')
    expect(last(before, 'amzn-rpo')?.end ?? '').not.toBe('2026-09-30')
    expect(live.filers.map((f) => f.ticker)).toEqual(['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL'])

    // The exports serve the same facts and points.
    const csv = await collect(csvChunks(db, EXPORT_TABLES.exposure_quarters!))
    expect(csv).toContain('msft-capex,MSFT,Microsoft,capex')
    const facts = await collect(csvChunks(db, EXPORT_TABLES.filed_facts!))
    expect(facts.split('\r\n').length - 2).toBe((await db.select().from(schema.filedFacts)).length)
  })

  it('names the CIK the whitelist holds, or refuses the block', () => {
    const bad = YAML.replace(`CIK${AMZN}.json`, `CIK${MSFT}.json`)
    expect(() => readFiledFactSources(bad, parseCikWhitelistBlock(bad))).toThrow(
      'url does not name CIK',
    )
  })
})

describe('filedFactAlert', () => {
  it('stays quiet on the first read and on an old filing', () => {
    const s = buildSeries([
      fact({
        start: '2026-01-01',
        end: '2026-03-31',
        value: 30,
        filed: '2026-11-01',
        fetched_at: '2026-11-04T00:00:00.000Z',
      }),
    ]).find((x) => x.id === 'googl-capex')!
    const now = new Date('2026-11-04T12:00:00Z')
    const earlier = () => []
    expect(
      filedFactAlert(s, { now, firstReadAt: '2026-11-04T00:00:00.000Z', cik: '1', earlier }),
    ).toBeNull()
    expect(
      filedFactAlert(s, {
        now: new Date('2027-01-01T00:00:00Z'),
        firstReadAt: '2026-01-01T00:00:00.000Z',
        cik: '1',
        earlier,
      }),
    ).toBeNull()
    expect(
      filedFactAlert(s, { now, firstReadAt: '2026-01-01T00:00:00.000Z', cik: '1', earlier }),
    ).not.toBeNull()
  })

  // Two filings of one series: the older one before the baseline read, the
  // newer one fresh. `alertOn` runs the rule on the newest point.
  const now = new Date('2026-11-04T12:00:00Z')
  const ctx = (facts: StoredFact[]) => ({
    now,
    firstReadAt: '2026-08-01T00:00:00.000Z',
    cik: '1',
    earlier: earlierPoints(facts),
  })
  const alertOn = (facts: StoredFact[], id: string) => {
    const series = buildSeries(facts).find((x) => x.id === id)
    expect(series).toBeDefined()
    return filedFactAlert(series!, ctx(facts))
  }
  const older = { filed: '2026-07-30', accession_no: 'q2', fetched_at: '2026-07-31T00:00:00.000Z' }
  const newer = { filed: '2026-10-30', accession_no: 'q3', fetched_at: '2026-10-31T00:00:00.000Z' }
  const msftLab = (concept: string, value: number, end: string, f: typeof older, unit = 'USD') =>
    fact({
      ticker: 'MSFT',
      concept,
      dims: `srt:ScheduleOfEquityMethodInvestmentEquityMethodInvesteeNameAxis=${OPENAI}`,
      end,
      value,
      unit,
      ...f,
    })
  const COMMIT = 'msft:EquityMethodInvestmentsTotalFundingCommitments'
  const COMMIT_ID = 'msft-openai-equity-method-investments-total-funding-commitments'

  it('alerts on every lab commitment and claim series the filings carry, and not on shares held', () => {
    const facts = [
      ...extractInstanceFacts(
        fixtureText('fixtures/filed-facts/msft-20260930.xml'),
        { cik: MSFT, form: '10-Q', filed: '2026-10-30', accession_no: MSFT_Q },
        [OPENAI],
      ).map((f) => ({ ...f, ticker: 'MSFT', source_url: 'x', fetched_at: 'y' })),
      ...extractInstanceFacts(
        fixtureText('fixtures/filed-facts/amzn-20260930.xml'),
        { cik: AMZN, form: '10-Q', filed: '2026-10-30', accession_no: AMZN_Q },
        [ANTHROPIC],
      ).map((f) => ({ ...f, ticker: 'AMZN', source_url: 'x', fetched_at: 'y' })),
      ...extractInstanceFacts(
        fixtureText('fixtures/filed-facts/goog-20260930.xml'),
        { cik: '0001652044', form: '10-Q', filed: '2026-10-30', accession_no: 'g' },
        [],
      ).map((f) => ({ ...f, ticker: 'GOOGL', source_url: 'x', fetched_at: 'y' })),
    ]
    const series = buildSeries(facts)
    const alerting = series.filter(isAlerting).map((x) => x.label)
    for (const label of [
      'Total funding commitment',
      'Funding paid in',
      'Receivables from OpenAI',
      'Revenue from OpenAI',
      'Ownership stake',
      'Financing Amazon makes available to Anthropic, maximum',
      'Financing available to Anthropic now',
      'Commitment Anthropic added to Amazon’s backlog',
      'Backlog from OpenAI',
      'Backlog from Crux AI',
    ]) {
      expect(alerting).toContain(label)
    }
    expect(alerting).not.toContain('Anthropic shares held')
  })

  it('is notable on a new point, critical on a series’ first', () => {
    const one = [msftLab(COMMIT, 13e9, '2026-09-30', newer)]
    expect(alertOn(one, COMMIT_ID)!.alert).toMatchObject({
      severity: 'critical',
      headline: 'Microsoft’s funding commitment to OpenAI reaches $13.0B at 2026-09-30',
    })
    expect(alertOn(one, COMMIT_ID)!.alert.explanation).toContain(
      'It’s the first time Microsoft’s filings report this line.',
    )
    // A filing that brings a line with its comparative is still the line's first.
    const withComparative = [
      msftLab(COMMIT, 13e9, '2026-09-30', newer),
      msftLab(COMMIT, 11e9, '2026-06-30', newer),
    ]
    expect(alertOn(withComparative, COMMIT_ID)!.alert.severity).toBe('critical')
    const two = [
      msftLab(COMMIT, 12e9, '2026-06-30', older),
      msftLab(COMMIT, 13e9, '2026-09-30', newer),
    ]
    expect(alertOn(two, COMMIT_ID)!.alert).toMatchObject({
      severity: 'notable',
      headline:
        'Microsoft’s funding commitment to OpenAI reaches $13.0B at 2026-09-30, up from $12.0B',
    })
  })

  it('is critical when a commitment or stake moves 25% or more, and not for other series', () => {
    const commit = (from: number, to: number) =>
      alertOn(
        [msftLab(COMMIT, from, '2026-06-30', older), msftLab(COMMIT, to, '2026-09-30', newer)],
        COMMIT_ID,
      )!.alert
    expect(commit(10e9, 12.5e9)).toMatchObject({ severity: 'critical' })
    expect(commit(10e9, 12.5e9).explanation).toContain('That’s a 25% move from the point before.')
    expect(commit(10e9, 7.5e9).severity).toBe('critical')
    expect(commit(10e9, 12.4e9).severity).toBe('notable')

    const STAKE = 'us-gaap:EquityMethodInvestmentOwnershipPercentage'
    const stake = alertOn(
      [
        msftLab(STAKE, 0.24, '2026-06-30', older, 'pure'),
        msftLab(STAKE, 0.32, '2026-09-30', newer, 'pure'),
      ],
      'msft-openai-equity-method-investment-ownership-percentage',
    )!.alert
    expect(stake).toMatchObject({
      severity: 'critical',
      headline: 'Microsoft’s stake in OpenAI rises to 32% at 2026-09-30, from 24%',
    })
    expect(stake.explanation).toContain('ownership stake of 32%')

    // Receivables are a claim, not a commitment: a 50% move stays notable.
    const AR = 'us-gaap:AccountsReceivableNet'
    expect(
      alertOn(
        [msftLab(AR, 4e9, '2026-06-30', older), msftLab(AR, 6e9, '2026-09-30', newer)],
        'msft-openai-accounts-receivable-net',
      )!.alert.severity,
    ).toBe('notable')

    // A lab backlog is a commitment. A fall of 25% or more is critical, and reads as a fall.
    const openai = (value: number, end: string, f: typeof older) =>
      fact({
        ticker: 'AMZN',
        concept: 'us-gaap:RevenueRemainingPerformanceObligation',
        dims: 'srt:MajorCustomersAxis=amzn:OpenAIGroupPBCMember',
        end,
        value,
        ...f,
      })
    expect(
      alertOn(
        [openai(38e9, '2026-06-30', older), openai(28e9, '2026-09-30', newer)],
        'amzn-rpo-openai',
      )!.alert,
    ).toMatchObject({
      severity: 'critical',
      headline: 'Amazon’s backlog from OpenAI falls to $28.0B at 2026-09-30, from $38.0B',
    })
  })

  it('skips a period an earlier filing reported, and a balance that didn’t move', () => {
    // The newer 10-Q repeats June's balance (a restated value) and adds no later one.
    const restated = [
      msftLab(COMMIT, 13e9, '2026-06-30', older),
      msftLab(COMMIT, 14e9, '2026-06-30', newer),
    ]
    const series = buildSeries(restated).find((x) => x.id === COMMIT_ID)!
    expect(series.points.at(-1)).toMatchObject({ value: 14e9, accession_no: 'q3' })
    expect(alertOn(restated, COMMIT_ID)).toBeNull()
    const repeated = [
      msftLab(COMMIT, 13e9, '2026-06-30', older),
      msftLab(COMMIT, 13e9, '2026-06-30', newer),
    ]
    expect(alertOn(repeated, COMMIT_ID)).toBeNull()
    const flat = [
      msftLab(COMMIT, 13e9, '2026-06-30', older),
      msftLab(COMMIT, 13e9, '2026-09-30', newer),
    ]
    expect(alertOn(flat, COMMIT_ID)).toBeNull()
  })
})
