import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { RevenuePeriod } from '../../companies/shared/types/revenue'
import { queryContext } from '#layers/core/server/utils/terminal-db'
import {
  filedFigures,
  queryGroundTruth,
  resolutionsOf,
  scoreReport,
  spanLabel,
  statedSpan,
  tallyOf,
  waitingOf,
} from '../server/utils/terminal-ground-truth'
import type { StoredHeadline } from '../server/utils/terminal-reported'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// Press reports of a lab's revenue against the figures its filings printed
// later. The filed rows are Anthropic's, as /api/revenue served them on
// 2026-11-19 (S-1 of 2026-10-26, S-1/A of 2026-11-02, 424B4 of 2026-11-19),
// and the headlines are real GDELT rows from /export/reported_figures the same
// day, except where a test says it made one up.

const CIK = '0002130357'
const S1 = '0001628280-26-067168'
const S1A = '0001628280-26-068676'
const B4 = '0001628280-26-074944'
const FILED: Record<string, string> = {
  [S1]: '2026-10-26',
  [S1A]: '2026-11-02',
  [B4]: '2026-11-19',
}
const FORM: Record<string, string> = { [S1]: 'S-1', [S1A]: 'S-1/A', [B4]: '424B4' }

function period(start: string, end: string, val: number, accession_no: string): RevenuePeriod {
  return {
    entity_key: `revenue:${CIK}:Revenue:${accession_no}:${start}:${end}`,
    start,
    end,
    days: Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1,
    fy: null,
    fp: null,
    form: FORM[accession_no]!,
    filed: FILED[accession_no]!,
    accession_no,
    filing_url: `https://www.sec.gov/Archives/edgar/data/2130357/${accession_no.replace(/-/g, '')}/`,
    tag: 'Revenue',
    val,
    frame: null,
    basis: 'prospectus',
    unaudited: !(start.endsWith('-01-01') && end.endsWith('-12-31')),
    source_url: `https://www.sec.gov/Archives/edgar/data/2130357/${accession_no.replace(/-/g, '')}/doc.htm`,
    fetched_at: `${FILED[accession_no]}T12:00:00.000Z`,
  }
}

/** Every filing's row for every period it printed: the S-1 has no nine-month column. */
const ROWS: RevenuePeriod[] = [
  ...[S1, S1A, B4].flatMap((a) => [
    period('2024-01-01', '2024-12-31', 386e6, a),
    period('2025-01-01', '2025-12-31', 4585e6, a),
  ]),
  period('2025-01-01', '2025-06-30', 1163e6, S1),
  period('2026-01-01', '2026-06-30', 16286e6, S1),
  ...[S1A, B4].flatMap((a) => [
    period('2025-01-01', '2025-09-30', 2545e6, a),
    period('2026-01-01', '2026-09-30', 33242e6, a),
  ]),
]

function headline(
  published_at: string,
  amount: number,
  title: string,
  over: Partial<StoredHeadline> = {},
): StoredHeadline {
  const url = `https://example.com/${encodeURIComponent(title)}`
  return {
    lab: 'anthropic',
    metric: 'revenue',
    basis: 'reported',
    currency: 'USD',
    amount,
    amount_text: `$${amount / 1e9} billion`,
    period: null,
    title,
    outlet: 'example.com',
    url,
    published_at,
    outlets: 1,
    source_url: url,
    fetched_at: '2026-11-07T22:02:03.382Z',
    // Read back from GDELT's archive on the day the feature shipped.
    found_at: '2026-11-07T22:02:03.382Z',
    ...over,
  }
}

const FY25 = headline(
  '2026-09-29T07:15:00.000Z',
  4.6e9,
  'Anthropic’s IPO prospectus shows nearly $4.6 billion in 2025 revenue and a $42 billion net loss',
  { period: '2025' },
)
const Q3_FT = headline(
  '2026-10-14T23:00:00.000Z',
  16.8e9,
  'Anthropic Q3 revenue climbs to $16.8 billion: Report',
)
const Q3_POST = headline(
  '2026-10-14T23:45:00.000Z',
  17e9,
  'Anthropic revenue surges 45% to nearly $17B in third quarter',
)
const H1 = headline(
  '2026-10-24T04:45:00.000Z',
  16.3e9,
  'Anthropic’s Revenue Surged to $16.3 Billion in the First Half of 2026, Up From $1.1 Billion a Year Ago',
)
const H1_PRIOR = { ...H1, amount: 1.1e9, amount_text: '$1.1 Billion' }
const AFTER_S1 = headline(
  '2026-10-26T16:45:00.000Z',
  16.3e9,
  'Anthropic’s S-1 IPO prospectus shows $16.3 billion in revenue and an $80.7 billion net loss',
)
const AFTER_S1A = headline(
  '2026-11-02T15:45:00.000Z',
  17e9,
  'Anthropic reports $17 billion in Q3 revenue, purchase commitments of $895.4 billion in revised S-1',
)
const AFTER_S1A_STATED = headline(
  '2026-11-02T19:00:00.000Z',
  16.96e9,
  'Anthropic Q3 2026 Revenue Jumps 47% to $16.96 Billion as Loss Narrows Ahead of IPO',
  { period: '2026-Q3' },
)

describe('periods', () => {
  it('names a calendar span the way a reader would', () => {
    expect(spanLabel('2025-01-01', '2025-12-31')).toBe('2025')
    expect(spanLabel('2026-07-01', '2026-09-30')).toBe('Q3 2026')
    expect(spanLabel('2026-01-01', '2026-06-30')).toBe('First half of 2026')
    expect(spanLabel('2025-07-01', '2025-12-31')).toBe('Second half of 2025')
    expect(spanLabel('2026-01-01', '2026-09-30')).toBe('First nine months of 2026')
    // Oracle's fiscal year: not a calendar span.
    expect(spanLabel('2025-06-01', '2026-05-31')).toBe('2025-06-01 to 2026-05-31')
  })

  it('reads the span a headline’s period names', () => {
    expect(statedSpan('2025')).toEqual({ start: '2025-01-01', end: '2025-12-31' })
    expect(statedSpan('2026-Q3')).toEqual({ start: '2026-07-01', end: '2026-09-30' })
    expect(statedSpan('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' })
    expect(statedSpan('last year')).toBeNull()
  })
})

describe('filed figures', () => {
  const figures = filedFigures(ROWS)
  const by = (label: string) => figures.find((f) => f.label === label)!

  it('dates a period by the first filing that printed it', () => {
    expect(by('2025')).toMatchObject({ val: 4585e6, first_filed: '2026-10-26', form: 'S-1' })
    expect(by('First nine months of 2026')).toMatchObject({
      val: 33242e6,
      first_filed: '2026-11-02',
      form: 'S-1/A',
      derived_from: null,
    })
  })

  it('subtracts two periods with the same start, public from the later filing', () => {
    expect(by('Q3 2026')).toMatchObject({
      start: '2026-07-01',
      end: '2026-09-30',
      days: 92,
      val: 16956e6,
      first_filed: '2026-11-02',
      accession_no: S1A,
      unaudited: true,
    })
    expect(by('Q3 2026').derived_from).toEqual([
      expect.objectContaining({ end: '2026-09-30', val: 33242e6 }),
      expect.objectContaining({ end: '2026-06-30', val: 16286e6 }),
    ])
    // Both halves of this one were in the S-1.
    expect(by('Second half of 2025')).toMatchObject({ val: 3422e6, first_filed: '2026-10-26' })
    expect(by('Q4 2025')).toMatchObject({ val: 2040e6, first_filed: '2026-11-02' })
    expect(figures).toHaveLength(6 + 4)
  })
})

describe('scoring a report', () => {
  const figures = filedFigures(ROWS)
  const score = (h: StoredHeadline) => scoreReport(h, figures).report

  it('scores a headline that names its year against that year', () => {
    const r = score(FY25)
    expect(r).toMatchObject({
      state: 'matched',
      matched_by: 'stated',
      filed_label: '2025',
      filed_val: 4585e6,
      lead_days: 27,
      held_before_filing: false,
    })
    expect(r.error_pct).toBeCloseTo(0.327, 2)
  })

  it('takes the nearest figure not yet filed when the headline names no year', () => {
    // 16.8 is 3.2% from the first half (filed 10-26) and 0.9% from the third quarter (filed 11-02).
    const ft = score(Q3_FT)
    expect(ft).toMatchObject({
      state: 'matched',
      matched_by: 'nearest',
      filed_label: 'Q3 2026',
      lead_days: 19,
    })
    expect(ft.error_pct).toBeCloseTo(-0.92, 2)
    expect(score(Q3_POST)).toMatchObject({ state: 'matched', filed_label: 'Q3 2026' })
    expect(score(H1)).toMatchObject({
      state: 'matched',
      filed_label: 'First half of 2026',
      lead_days: 2,
    })
  })

  it('never scores a report from the filing day on', () => {
    expect(score(AFTER_S1)).toMatchObject({
      state: 'restated',
      filed_label: 'First half of 2026',
      lead_days: null,
    })
    expect(score(AFTER_S1A)).toMatchObject({ state: 'restated', filed_label: 'Q3 2026' })
    expect(score(AFTER_S1A_STATED)).toMatchObject({ state: 'restated', matched_by: 'stated' })
  })

  it('leaves a figure nothing filed is within 5% of open, with the nearest shown', () => {
    const r = score(H1_PRIOR)
    expect(r).toMatchObject({
      state: 'open',
      matched_by: null,
      filed_label: 'First half of 2025',
      lead_days: null,
    })
    expect(r.error_pct).toBeCloseTo(-5.42, 2)
  })

  it('calls a named period more than 5% off a miss, and a period nobody filed open', () => {
    // Made up: no outlet reported this.
    const wrong = headline('2026-09-20T12:00:00.000Z', 5e9, 'Anthropic made $5 billion in 2025', {
      period: '2025',
    })
    expect(score(wrong)).toMatchObject({ state: 'missed', filed_label: '2025', lead_days: 36 })
    const future = headline('2026-11-10T12:00:00.000Z', 685e9, 'Anthropic made $685 billion', {
      period: '2030',
    })
    expect(score(future)).toMatchObject({ state: 'open', filed_label: null, error_pct: null })
  })

  it('knows a headline we stored before the filing from one read back later', () => {
    const live = { ...Q3_FT, found_at: '2026-10-15T00:10:00.000Z' }
    expect(score(live).held_before_filing).toBe(true)
    expect(score(Q3_FT).held_before_filing).toBe(false)
  })

  it('has nothing to compare for a lab with no filed figure', () => {
    expect(scoreReport(Q3_FT, []).report).toMatchObject({ state: 'open', filed_label: null })
  })
})

describe('the ledger', () => {
  const figures = filedFigures(ROWS)
  const all = [FY25, Q3_FT, Q3_POST, H1, H1_PRIOR, AFTER_S1, AFTER_S1A, AFTER_S1A_STATED]
  const scored = all.map((h) => scoreReport(h, figures))
  const resolutions = resolutionsOf('anthropic', scored)

  it('groups reports under the figure that settled them, newest filing first', () => {
    expect(resolutions.map((r) => [r.filed.label, r.reports.length, r.lead_days])).toEqual([
      ['Q3 2026', 2, 19],
      ['First half of 2026', 1, 2],
      ['2025', 1, 27],
    ])
    const q3 = resolutions[0]!
    expect(q3).toMatchObject({ median: 16.9e9, low: 16.8e9, high: 17e9, held: 0 })
    expect(q3.error_pct).toBeCloseTo(-0.33, 2)
    expect(q3.reports[0]!.title).toBe(Q3_FT.title)
  })

  it('tallies what was scored and what was not', () => {
    const tally = tallyOf(resolutions, 3, 1)
    expect(tally).toMatchObject({
      periods: 3,
      reports: 4,
      missed: 0,
      median_lead_days: 19,
      held: 0,
      restated: 3,
      open: 1,
    })
    expect(tally.median_abs_error_pct).toBeCloseTo(0.293, 2)
    expect(tallyOf([], 0, 0)).toMatchObject({
      median_abs_error_pct: null,
      median_lead_days: null,
    })
  })

  it('lists what no filing can score, and why', () => {
    const openai = headline(
      '2026-11-11T13:30:00.000Z',
      10e9,
      'OpenAI revenue rises to $10 billion',
      {
        lab: 'openai',
      },
    )
    const runRate = headline(
      '2026-11-10T19:00:00.000Z',
      81e9,
      'Anthropic run-rate hits $81 billion',
      {
        metric: 'revenue_run_rate',
      },
    )
    const forecast = headline('2026-11-10T12:00:00.000Z', 685e9, 'Anthropic sees $685 billion', {
      basis: 'projected',
    })
    const waiting = waitingOf([...all, openai, runRate, forecast], new Set(['anthropic']))
    expect(waiting.map((w) => [w.lab, w.metric, w.reports, w.reason])).toEqual([
      ['anthropic', 'revenue_run_rate', 1, 'not-in-filings'],
      ['openai', 'revenue', 1, 'no-filing'],
    ])
    expect(waiting[0]!.latest).not.toHaveProperty('found_at')
  })
})

describe('the payload', () => {
  const db = drizzle(env.DB, { schema })
  const sourcesYaml = fixtureText('sources.yaml')
  const NOW = new Date('2026-11-19T20:00:00Z')
  const ctx = () => queryContext(sourcesYaml, null, () => NOW)
  const HASH = (n: number) => n.toString(16).padStart(64, '0')

  beforeEach(async () => {
    await db.delete(schema.reportedFigures)
    await db.delete(schema.reportedArticles)
    await db.delete(schema.entities)
  })

  const entity = (entity_type: string, entity_key: string, payload: object, n: number) => ({
    source_id: 'prospectus-revenue-anthropic',
    entity_key,
    entity_type,
    provider: 'anthropic',
    content_hash: HASH(n),
    payload: JSON.stringify(payload),
    snapshot_id: HASH(n),
    first_seen_at: '2026-11-02T12:00:00.000Z',
    source_url: 'https://www.sec.gov/Archives/edgar/data/2130357/doc.htm',
    fetched_at: '2026-11-02T12:00:00.000Z',
  })

  async function seed(headlines: readonly StoredHeadline[]) {
    // One row a statement: D1 binds at most 100 parameters.
    const rows = [
      entity(
        'filer',
        'filer:anthropic',
        {
          cik: CIK,
          name: 'Anthropic, PBC',
          resolved_form: 'S-1',
          resolved_accession: S1,
          resolved_file_date: '2026-10-26',
        },
        0,
      ),
      ...ROWS.map((p, i) =>
        entity(
          'revenue',
          p.entity_key,
          {
            cik: CIK,
            entity_name: 'Anthropic, PBC',
            start: p.start,
            end: p.end,
            accession_no: p.accession_no,
            tag: p.tag,
            form: p.form,
            filed: p.filed,
            val: p.val,
            taxonomy: 'prospectus',
            unaudited: p.unaudited,
          },
          i + 1,
        ),
      ),
    ]
    for (const row of rows) await db.insert(schema.entities).values(row)
    for (const [i, h] of headlines.entries()) {
      const title_key = `${h.title.toLowerCase()} ${i}`
      await db.insert(schema.reportedArticles).values({
        id: HASH(100 + i),
        title_key,
        title: h.title,
        outlet: h.outlet,
        url: h.url,
        published_at: h.published_at,
        found_at: h.found_at,
        record_id: `r${i}`,
        source_url: h.url,
        fetched_at: h.fetched_at,
      })
      await db.insert(schema.reportedFigures).values({
        id: HASH(200 + i),
        title_key,
        article_id: HASH(100 + i),
        lab: h.lab,
        metric: h.metric,
        basis: h.basis,
        currency: h.currency,
        amount: h.amount,
        amount_text: h.amount_text,
        period: h.period,
        published_at: h.published_at,
        judged_at: h.found_at,
        source_url: h.url,
        fetched_at: h.fetched_at,
      })
    }
  }

  it('scores an issuer’s reports and leaves the other labs waiting', async () => {
    const openai = headline(
      '2026-11-11T13:30:00.000Z',
      10e9,
      'OpenAI revenue rises to $10 billion',
      {
        lab: 'openai',
      },
    )
    await seed([FY25, Q3_FT, Q3_POST, H1, H1_PRIOR, AFTER_S1, openai])

    const data = await queryGroundTruth(db, ctx())
    expect(data.tolerance_pct).toBe(5)
    expect(data.resolutions.map((r) => [r.lab, r.filed.label, r.reports.length])).toEqual([
      ['anthropic', 'Q3 2026', 2],
      ['anthropic', 'First half of 2026', 1],
      ['anthropic', '2025', 1],
    ])
    expect(data.resolutions[0]!.filed.filing_url).toContain('000162828026068676')
    expect(data.open.map((r) => r.amount)).toEqual([1.1e9])
    expect(data.tally).toMatchObject({ periods: 3, reports: 4, restated: 1, open: 1, held: 0 })
    expect(data.waiting).toEqual([
      expect.objectContaining({ lab: 'openai', metric: 'revenue', reason: 'no-filing' }),
    ])
    expect(data.first_stored_at).toBe('2026-11-07T22:02:03.382Z')
    expect(data.alerts).toMatchObject({ rated: 0, press: { matched: 0 } })
  })

  it('scores one lab alone when given a lab, tallies included', async () => {
    const openai = headline(
      '2026-11-11T13:30:00.000Z',
      10e9,
      'OpenAI revenue rises to $10 billion',
      { lab: 'openai' },
    )
    await seed([FY25, Q3_FT, Q3_POST, H1, H1_PRIOR, AFTER_S1, openai])

    const anthropic = await queryGroundTruth(db, ctx(), 'anthropic')
    expect(anthropic.resolutions.map((r) => r.lab)).toEqual(['anthropic', 'anthropic', 'anthropic'])
    expect(anthropic.tally).toMatchObject({ periods: 3, reports: 4, restated: 1, open: 1 })
    expect(anthropic.waiting).toEqual([])

    const other = await queryGroundTruth(db, ctx(), 'openai')
    expect(other.resolutions).toEqual([])
    expect(other.open).toEqual([])
    expect(other.tally).toMatchObject({ periods: 0, reports: 0, restated: 0, open: 0 })
    expect(other.waiting).toEqual([
      expect.objectContaining({ lab: 'openai', metric: 'revenue', reason: 'no-filing' }),
    ])
    expect(other.deals.unread).toBe(0)
  })

  it('is empty, not an error, before anything is stored', async () => {
    const data = await queryGroundTruth(db, ctx())
    expect(data).toMatchObject({
      resolutions: [],
      open: [],
      waiting: [],
      first_stored_at: null,
      tally: { periods: 0, reports: 0, median_abs_error_pct: null },
    })
  })
})
