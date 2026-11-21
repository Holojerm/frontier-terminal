import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { extractGuidance } from '../../companies/server/exposure/guidance'
import {
  checkAlert,
  filedYearToDate,
  guidanceAlerts,
  guidanceFor,
  previousGuidance,
  revisionAlert,
  revisionOf,
  unverified,
} from '../../companies/server/exposure/guidance-alerts'
import { runFiledFacts } from '../../companies/server/exposure/ingest'
import type { StoredFact } from '../../companies/server/exposure/series'
import type { FetchSource } from '#layers/core/server/utils/pipeline-fetch'
import { alertTerms } from '../server/pipeline/track-record/terms'
import { fixtureText, provenanceOf } from '#layers/core/test/pipeline/fixtures'

// The capex-guidance rule (exposure/guidance-alerts.ts): a revision against
// the filer's previous figure, held to its stored release; a 10-Q or 10-K
// checked against the newest figure; the quiet baseline; and one run that
// raises both. Figures are Meta's and Amazon's own, from the committed
// releases and company facts. The July 2026 Meta release is made up for the
// test, with the $130–145 billion range Meta's October release names as its
// prior outlook.

const META = '0001326801'
const AMZN = '0001018724'
const PPE = 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment'
const LEASES = 'us-gaap:FinanceLeasePrincipalPayments'

const OCT_2026 = '0001628280-26-066700'
const OCT_10Q = '0001628280-26-066773'
const JUL_2026 = '0001628280-26-050600'
const JUL_SENTENCE =
  'We anticipate 2026 capital expenditures, including principal payments on finance leases, to be in the range of $130-145 billion.'
const JUL_HTML = `<html><body><div>${JUL_SENTENCE}</div></body></html>`
const OCT_HTML = fixtureText('fixtures/guidance/meta-2026-10-21-ex99-1.htm')

const AT = '2026-10-22T21:00:00.000Z'

function stored(
  over: Partial<StoredGuidance> & Pick<StoredGuidance, 'accession_no' | 'filed'>,
  html: string,
  ticker = 'META',
): StoredGuidance {
  const [g] = extractGuidance(html)
  return {
    id: `${ticker}-${over.accession_no}`,
    ticker,
    cik: ticker === 'META' ? META : AMZN,
    ...g!,
    raw_key: `guidance/${ticker.toLowerCase()}/${over.accession_no}.htm`,
    first_seen_at: AT,
    source_url: `https://www.sec.gov/Archives/edgar/data/x/${over.accession_no}.htm`,
    fetched_at: AT,
    ...over,
  }
}

const JUL = stored(
  { accession_no: JUL_2026, filed: '2026-07-29', fetched_at: '2026-07-30T00:00:00.000Z' },
  JUL_HTML,
)
const OCT = stored({ accession_no: OCT_2026, filed: '2026-10-21' }, OCT_HTML)
const amznHtml = (n: number) =>
  `<p>We expect 2026 cash capital expenditures to be approximately $${n} billion.</p>`
const AMZN_FEB = stored({ accession_no: 'a-feb', filed: '2026-02-05' }, amznHtml(200), 'AMZN')
const AMZN_OCT = stored({ accession_no: 'a-oct', filed: '2026-10-21' }, amznHtml(220), 'AMZN')
const baseline = { now: new Date(AT), firstReadAt: '2026-07-01T00:00:00.000Z' }

const fact = (
  concept: string,
  start: string,
  end: string,
  value: number,
  over: Partial<StoredFact> = {},
): StoredFact => ({
  ticker: 'META',
  concept,
  dims: '',
  start,
  end,
  value,
  unit: 'USD',
  form: '10-Q',
  filed: '2026-10-22',
  accession_no: OCT_10Q,
  cik: META,
  source_url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${META}.json`,
  fetched_at: AT,
  ...over,
})

// Meta's 10-Q for the third quarter of 2026: this year's nine months, and the
// same months of 2025 it prints beside them.
const META_Q3 = [
  fact(PPE, '2026-01-01', '2026-09-30', 83_055_000_000),
  fact(LEASES, '2026-01-01', '2026-09-30', 2_769_000_000),
  fact(PPE, '2025-01-01', '2025-09-30', 48_308_000_000),
  fact(LEASES, '2025-01-01', '2025-09-30', 1_770_000_000),
]

describe('the verbatim gate', () => {
  it('holds a figure whose sentence is in the stored release and reads as it', () => {
    expect(unverified(OCT, OCT_HTML)).toBeNull()
    expect(OCT).toMatchObject({ fiscal_year: 2026, low: 135e9, high: 145e9 })
  })

  it('refuses a sentence the release does not print, or a figure it does not state', () => {
    expect(unverified({ ...OCT, sentence: JUL_SENTENCE }, OCT_HTML)).toBe('sentence-not-in-exhibit')
    expect(unverified({ ...OCT, high: 150e9 }, OCT_HTML)).toBe('figure-not-in-sentence')
    expect(unverified({ ...OCT, fiscal_year: 2027 }, OCT_HTML)).toBe('figure-not-in-sentence')
  })
})

describe('a revision', () => {
  it('names how a range moved against the previous one', () => {
    expect(revisionOf({ low: 115e9, high: 135e9 }, null)).toBe('first')
    expect(revisionOf({ low: 135e9, high: 145e9 }, { low: 135e9, high: 145e9 })).toBe('restated')
    expect(revisionOf({ low: 125e9, high: 145e9 }, { low: 115e9, high: 135e9 })).toBe('raised')
    expect(revisionOf({ low: 135e9, high: 145e9 }, { low: 130e9, high: 145e9 })).toBe('raised')
    expect(revisionOf({ low: 200e9, high: 200e9 }, { low: 220e9, high: 220e9 })).toBe('cut')
    expect(revisionOf({ low: 132e9, high: 140e9 }, { low: 130e9, high: 145e9 })).toBe('narrowed')
    expect(revisionOf({ low: 125e9, high: 150e9 }, { low: 130e9, high: 145e9 })).toBe('widened')
  })

  it('is critical when the range moves, and quotes the release', () => {
    expect(previousGuidance(OCT, [OCT, JUL])).toBe(JUL)
    const a = revisionAlert(OCT, JUL, baseline)!
    expect(a.alert.severity).toBe('critical')
    // Meta's sentence says "narrowed"; the headline names the end that moved.
    expect(a.alert.headline).toBe(
      'Meta raises the low end of its 2026 capex guidance to $135B–$145B, from $130B–$145B',
    )
    expect(a.alert.explanation).toContain(`“${OCT.sentence}”`)
    expect(a.alert.explanation).toContain(`“${JUL_SENTENCE}”`)
    expect(a.alert.rule).toBe('guidance-floor')
    expect(a.change).toMatchObject({
      entity_type: 'guidance',
      entity_key: 'guidance:META:2026',
      provider: 'meta',
      change_type: 'modified',
    })
    expect(JSON.parse(a.change.after_json!)).toMatchObject({
      filer: 'Meta',
      low: 135e9,
      revision: 'raised',
    })
    expect(JSON.parse(a.change.before_json!)).toMatchObject({ low: 130e9, high: 145e9 })
    expect(JSON.parse(a.alert.change_ids)).toEqual([a.change.id])
  })

  it('is info when the range is restated, notable for a first figure, and a single figure moves too', () => {
    const again = { ...OCT, id: 'again', accession_no: '0001628280-26-066900', filed: '2026-10-22' }
    expect(revisionAlert(again, OCT, baseline)!.alert).toMatchObject({
      severity: 'info',
      headline: 'Meta restates its 2026 capex guidance of $135B–$145B',
    })
    expect(
      revisionAlert(JUL, null, { ...baseline, now: new Date('2026-07-30T12:00:00Z') })!.alert,
    ).toMatchObject({
      severity: 'notable',
      headline: 'Meta guides 2026 capex to $130B–$145B',
    })
    expect(revisionAlert(AMZN_OCT, AMZN_FEB, baseline)!.alert).toMatchObject({
      severity: 'critical',
      headline: 'Amazon raises its 2026 capex guidance to $220B, from $200B',
    })
  })

  it('stays quiet on an old release and on the baseline read', () => {
    expect(revisionAlert(JUL, null, baseline)).toBeNull() // filed more than FRESH_DAYS ago
    expect(revisionAlert(OCT, JUL, { ...baseline, firstReadAt: AT })).toBeNull()
  })
})

describe('a check against a 10-Q or 10-K', () => {
  it('adds up the lines Meta guides, from the filing’s own year to date', () => {
    expect(filedYearToDate('META', META_Q3)).toEqual([
      expect.objectContaining({
        fiscal_year: 2026,
        start: '2026-01-01',
        end: '2026-09-30',
        months: 9,
        value: 85_824_000_000,
        accession_no: OCT_10Q,
      }),
    ])
    // Amazon guides a net figure we don't hold, Microsoft prints none: no check.
    expect(
      filedYearToDate(
        'AMZN',
        META_Q3.map((f) => ({ ...f, ticker: 'AMZN' })),
      ),
    ).toEqual([])
    expect(
      filedYearToDate(
        'MSFT',
        META_Q3.map((f) => ({ ...f, ticker: 'MSFT' })),
      ),
    ).toEqual([])
    // A filing missing one of the lines is not scored.
    expect(
      filedYearToDate(
        'META',
        META_Q3.filter((f) => f.concept === PPE),
      ),
    ).toEqual([])
  })

  it('is notable when the pace so far lands the year outside the range', () => {
    const [ytd] = filedYearToDate('META', META_Q3)
    // A release of the same day as the 10-Q counts; one after it does not.
    expect(guidanceFor(ytd!, [JUL, OCT])).toBe(OCT)
    expect(guidanceFor(ytd!, [JUL, { ...OCT, filed: '2026-10-23' }])).toBe(JUL)
    const a = checkAlert(ytd!, OCT, META_Q3, baseline)!
    expect(a.alert.severity).toBe('notable')
    expect(a.alert.headline).toBe(
      'Meta’s capex runs below its $135B–$145B guidance for 2026: $85.8B through 2026-09-30 leaves $49.2B–$59.2B for the rest of the year',
    )
    expect(a.alert.explanation).toContain(
      'At the pace so far the year comes to $114B, below the range.',
    )
    expect(a.change).toMatchObject({
      entity_type: 'guidance_check',
      entity_key: 'guidance_check:META:2026:2026-09-30',
      change_type: 'added',
    })
    expect(JSON.parse(a.change.after_json!)).toMatchObject({
      verdict: 'below',
      rest: { low: 49_176_000_000, high: 59_176_000_000 },
      guidance: { accession_no: OCT_2026 },
    })
  })

  it('is info when the pace sits inside it, and notable when the year is already past it', () => {
    const [ytd] = filedYearToDate('META', META_Q3)
    const inside = checkAlert(ytd!, { ...OCT, low: 110e9, high: 120e9 }, META_Q3, baseline)!
    expect(inside.alert.severity).toBe('info')
    expect(inside.alert.headline).toBe(
      'Meta’s capex is on pace for its $110B–$120B guidance for 2026: $85.8B through 2026-09-30 leaves $24.2B–$34.2B for the rest of the year',
    )
    const past = checkAlert(ytd!, { ...OCT, low: 80e9, high: 85e9 }, META_Q3, baseline)!
    expect(past.alert.severity).toBe('notable')
    expect(past.alert.headline).toBe(
      'Meta’s capex of $85.8B through 2026-09-30 already passes its $80.0B–$85.0B guidance for 2026',
    )
  })

  it('gives a 10-K’s verdict on the year, notable either way', () => {
    // Meta's 2025: $69.69B of purchases and $2.52B of lease principal against its October range of $70–72B.
    const k = {
      form: '10-K',
      filed: '2026-01-29',
      accession_no: '0001628280-26-003942',
      fetched_at: '2026-01-29T22:00:00.000Z',
    }
    const facts = [
      fact(PPE, '2025-01-01', '2025-12-31', 69_691_000_000, k),
      fact(LEASES, '2025-01-01', '2025-12-31', 2_524_000_000, k),
    ]
    const g = stored(
      { accession_no: '0001628280-25-047114', filed: '2025-10-29' },
      fixtureText('fixtures/guidance/meta-2025-10-29-ex99-1.htm'),
    )
    const [ytd] = filedYearToDate('META', facts)
    expect(guidanceFor(ytd!, [g])).toBe(g)
    const at = { now: new Date('2026-01-30T00:00:00Z'), firstReadAt: '2025-01-01T00:00:00.000Z' }
    const a = checkAlert(ytd!, g, facts, at)!
    expect(a.alert.severity).toBe('notable')
    expect(a.alert.headline).toBe(
      'Meta’s 2025 capex of $72.2B comes in above its $70.0B–$72.0B guidance',
    )
    expect(a.alert.explanation).toContain('The year comes in above it by 0.3%.')
    const met = checkAlert(ytd!, { ...g, high: 73e9 }, facts, at)!
    expect(met.alert).toMatchObject({
      severity: 'notable',
      headline: 'Meta’s 2025 capex of $72.2B lands inside its $70.0B–$73.0B guidance',
    })
    // A release filed the day of the 10-K is not a forecast of it.
    expect(guidanceFor(ytd!, [{ ...g, filed: '2026-01-29' }])).toBeNull()
  })

  it('stays quiet on an old filing and on the baseline read', () => {
    const [ytd] = filedYearToDate('META', META_Q3)
    expect(
      checkAlert(ytd!, OCT, META_Q3, { ...baseline, now: new Date('2026-12-01T00:00:00Z') }),
    ).toBeNull()
    expect(checkAlert(ytd!, OCT, META_Q3, { ...baseline, firstReadAt: AT })).toBeNull()
  })
})

describe('guidanceAlerts', () => {
  const read = (bodies: Record<string, string>) => async (key: string) => bodies[key] ?? null
  const b = {
    now: new Date(AT),
    firstReadAt: baseline.firstReadAt,
    firstReleaseReadAt: baseline.firstReadAt,
  }

  it('raises neither when the stored release is missing or does not print the sentence', async () => {
    const missing = await guidanceAlerts({ ticker: 'META' }, [JUL, OCT], META_Q3, read({}), b)
    expect(missing.out).toEqual([])
    expect(missing.rejected).toEqual([
      { accession_no: OCT_2026, fiscal_year: 2026, reason: 'exhibit-not-stored' },
    ])
    const other = await guidanceAlerts(
      { ticker: 'META' },
      [JUL, OCT],
      META_Q3,
      read({ [OCT.raw_key]: JUL_HTML }),
      b,
    )
    expect(other.out).toEqual([])
    expect(other.rejected.map((r) => r.reason)).toEqual(['sentence-not-in-exhibit'])
  })

  it('gives Amazon the revision and no check', async () => {
    const facts = META_Q3.map((f) => ({ ...f, ticker: 'AMZN', concept: PPE }))
    const { out } = await guidanceAlerts(
      { ticker: 'AMZN' },
      [AMZN_FEB, AMZN_OCT],
      facts,
      read({ [AMZN_OCT.raw_key]: amznHtml(220) }),
      b,
    )
    expect(out.map((a) => a.change.entity_type)).toEqual(['guidance'])
  })
})

describe('track-record terms', () => {
  it('searches both by the filer and capex guidance words', () => {
    const a = revisionAlert(OCT, JUL, baseline)!
    const [ytd] = filedYearToDate('META', META_Q3)
    const c = checkAlert(ytd!, OCT, META_Q3, baseline)!
    const terms = {
      who: ['Meta'],
      what: ['capex', 'capital expenditures'],
      also: ['guidance', 'outlook'],
    }
    expect(alertTerms([a.change])).toEqual(terms)
    expect(alertTerms([c.change])).toEqual(terms)
  })
})

// ---- the run ---------------------------------------------------------------

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
const archive = (accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/1326801/${accession.replace(/-/g, '')}/`
const indexPage = (accession: string, name: string) =>
  `<html><body>${accession}<table><tr><td>1</td><td><a href="/Archives/edgar/data/1326801/${accession.replace(/-/g, '')}/${name}">${name}</a></td><td>EX-99.1</td></tr></table></body></html>`

function world() {
  const companyfacts = JSON.parse(fixtureText('fixtures/filed-facts/companyfacts-meta.json'))
  // Before the third-quarter 10-Q: company facts without it.
  const early = structuredClone(companyfacts)
  for (const concept of Object.values(early.facts['us-gaap']) as {
    units: Record<string, { accn: string }[]>
  }[]) {
    for (const unit of Object.keys(concept.units)) {
      concept.units[unit] = concept.units[unit]!.filter((r) => r.accn !== OCT_10Q)
    }
  }
  const feed = (rows: [string, string, string, string, string][]) =>
    ok(
      JSON.stringify({
        cik: META,
        filings: {
          recent: {
            form: rows.map((r) => r[0]),
            accessionNumber: rows.map((r) => r[1]),
            filingDate: rows.map((r) => r[2]),
            primaryDocument: rows.map((r) => r[3]),
            items: rows.map((r) => r[4]),
          },
        },
      }),
    )
  const july: [string, string, string, string, string] = [
    '8-K',
    JUL_2026,
    '2026-07-29',
    'meta-8k.htm',
    '2.02,9.01',
  ]
  const docs: Record<string, FetchOutcome> = {
    [`https://data.sec.gov/submissions/CIK${META}.json`]: feed([july]),
    [`https://data.sec.gov/api/xbrl/companyfacts/CIK${META}.json`]: ok(JSON.stringify(early)),
    [`${archive(JUL_2026)}${JUL_2026}-index.html`]: ok(indexPage(JUL_2026, 'jul-ex991.htm')),
    [`${archive(JUL_2026)}jul-ex991.htm`]: ok(JUL_HTML),
    [`${archive(OCT_2026)}${OCT_2026}-index.html`]: ok(
      indexPage(OCT_2026, 'meta-09302026xexhibit991.htm'),
    ),
    [provenanceOf('guidance-meta-2026-10-21').source_url]: ok(OCT_HTML),
  }
  const october = () => {
    docs[`https://data.sec.gov/submissions/CIK${META}.json`] = feed([
      ['10-Q', OCT_10Q, '2026-10-22', 'meta-20260930.htm', ''],
      ['8-K', OCT_2026, '2026-10-21', 'meta-8k.htm', '2.02,9.01'],
      july,
    ])
    docs[`https://data.sec.gov/api/xbrl/companyfacts/CIK${META}.json`] = ok(
      JSON.stringify(companyfacts),
    )
  }
  const bodies = new Map<string, string>()
  const raw = {
    put: async (key: string, body: string) => {
      bodies.set(key, body)
    },
  }
  const readRaw = async (key: string) => bodies.get(key) ?? null
  const fetcher = async (s: FetchSource) => docs[s.url] ?? missing
  return { fetcher, raw, readRaw, october }
}

describe('runFiledFacts and the guidance rule', () => {
  beforeEach(async () => {
    await db.delete(schema.filedGuidance)
    await db.delete(schema.filedFactReads)
    await db.delete(schema.filedFacts)
    await db.delete(schema.alerts)
    await db.delete(schema.changes)
  })

  it('reads the first release quietly, then raises the revision and the 10-Q check once', async () => {
    const w = world()
    const first = await runFiledFacts(db, {
      ...w,
      now: new Date('2026-07-30T12:00:00Z'),
      sourcesYaml: YAML,
    })
    expect(first.alerts).toBe(0)
    expect(await db.select().from(schema.filedGuidance)).toHaveLength(1)

    w.october()
    const second = await runFiledFacts(db, { ...w, now: new Date(AT), sourcesYaml: YAML })
    const ours = await db
      .select()
      .from(schema.alerts)
      .where(eq(schema.alerts.rule, 'guidance-floor'))
    expect(ours.map((a) => [a.severity, a.headline]).sort()).toEqual([
      [
        'critical',
        'Meta raises the low end of its 2026 capex guidance to $135B–$145B, from $130B–$145B',
      ],
      [
        'notable',
        'Meta’s capex runs below its $135B–$145B guidance for 2026: $85.8B through 2026-09-30 leaves $49.2B–$59.2B for the rest of the year',
      ],
    ])
    expect(second.alerts).toBeGreaterThanOrEqual(2)
    const changes = await db.select().from(schema.changes)
    for (const a of ours) {
      const [id] = JSON.parse(a.change_ids) as string[]
      expect(changes.find((c) => c.id === id)?.entity_type).toMatch(/^guidance/)
    }

    // Run again: nothing new is written.
    const third = await runFiledFacts(db, {
      ...w,
      now: new Date('2026-10-23T04:00:00Z'),
      sourcesYaml: YAML,
    })
    expect(third.alerts).toBe(0)
    expect(
      await db.select().from(schema.alerts).where(eq(schema.alerts.rule, 'guidance-floor')),
    ).toHaveLength(2)
  })
})
