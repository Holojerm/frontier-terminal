import { beforeEach, describe, expect, it } from 'vitest'

import { fixtureText } from '#layers/core/test/pipeline/fixtures'
import { JUDGE_EXCLUDED_ENTITY_TYPES } from '#layers/core/server/pipeline/judge/pending'
import { FRESH_DAYS } from '../server/pipeline/deal-alerts'
import {
  REVENUE_RULE,
  freshResolutions,
  revenueFindings,
  writeRevenueScoreAlerts,
} from '../server/pipeline/revenue-alerts'
import { filedFigures, scoreReport } from '../server/utils/terminal-ground-truth'
import type { JudgedHeadline } from '../server/utils/terminal-reported'

// Anthropic's registration filings as /api/revenue served them on 2026-11-19 (S-1 of
// 2026-10-26, S-1/A of 2026-11-02), then a first 10-K, made up: 2026 at $45B, filed
// 2027-02-25, which also gives Q4 2026 as the year less the nine months.

const CIK = '0002130357'
const S1 = '0001628280-26-067168'
const S1A = '0001628280-26-068676'
const K10 = '0002130357-27-000004'
const FILED: Record<string, string> = {
  [S1]: '2026-10-26',
  [S1A]: '2026-11-02',
  [K10]: '2027-02-25',
}
const FORM: Record<string, string> = { [S1]: 'S-1', [S1A]: 'S-1/A', [K10]: '10-K' }

const filingUrl = (a: string) =>
  `https://www.sec.gov/Archives/edgar/data/2130357/${a.replace(/-/g, '')}/`

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
    filing_url: filingUrl(accession_no),
    tag: 'Revenue',
    val,
    frame: null,
    basis: accession_no === K10 ? 'xbrl' : 'prospectus',
    unaudited: !(start.endsWith('-01-01') && end.endsWith('-12-31')),
    source_url: `${filingUrl(accession_no)}doc.htm`,
    fetched_at: `${FILED[accession_no]}T22:00:00.000Z`,
  }
}

const BEFORE_10K: RevenuePeriod[] = [
  ...[S1, S1A].flatMap((a) => [
    period('2024-01-01', '2024-12-31', 386e6, a),
    period('2025-01-01', '2025-12-31', 4585e6, a),
  ]),
  period('2025-01-01', '2025-06-30', 1163e6, S1),
  period('2026-01-01', '2026-06-30', 16286e6, S1),
  period('2025-01-01', '2025-09-30', 2545e6, S1A),
  period('2026-01-01', '2026-09-30', 33242e6, S1A),
]
const ROWS: RevenuePeriod[] = [
  ...BEFORE_10K,
  period('2025-01-01', '2025-12-31', 4585e6, K10),
  period('2026-01-01', '2026-12-31', 45e9, K10),
]
const ISSUERS = [{ provider: 'anthropic' as const, rows: ROWS }]

function headline(
  published_at: string,
  amount: number,
  judged_at: string,
  over: Partial<JudgedHeadline> = {},
  n = 0,
): JudgedHeadline {
  const title = `Anthropic revenue reaches $${amount / 1e9} billion ${n}`
  const url = `https://example.com/${n}-${published_at.slice(0, 10)}`
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
    fetched_at: published_at,
    found_at: published_at,
    judged_at,
    ...over,
  }
}

// Held before the 10-K: one names 2026 (within 5%), one names Q4 2026 (outside it).
const FY26 = headline('2027-01-15T12:00:00.000Z', 44e9, '2027-01-15T13:00:00.000Z', {
  period: '2026',
})
const Q4 = headline(
  '2027-01-20T12:00:00.000Z',
  12.5e9,
  '2027-01-20T13:00:00.000Z',
  { period: '2026-Q4' },
  1,
)
const NOW = new Date('2027-03-01T12:00:00Z')

describe('the revenue-score rule, pure', () => {
  it('alerts once per filing, over every figure it scored, a match and a miss alike', () => {
    const resolved = freshResolutions(ISSUERS, [FY26, Q4], NOW)
    // The later period first, then the shorter: Q4 leads.
    expect(resolved.map((r) => [r.filed.label, r.reports[0]!.state])).toEqual([
      ['Q4 2026', 'missed'],
      ['2026', 'matched'],
    ])
    const findings = revenueFindings(ISSUERS, [FY26, Q4], NOW)
    expect(findings).toHaveLength(1)
    const [f] = findings
    expect(f).toMatchObject({
      rule: REVENUE_RULE,
      entity_type: 'revenue_score',
      entity_key: 'revenue_score:anthropic',
      provider: 'anthropic',
      period: K10,
      change_type: 'added',
      source_url: `${filingUrl(K10)}doc.htm`,
    })
    expect(f!.after).toMatchObject({
      form: '10-K',
      filed: '2027-02-25',
      periods: 2,
      reports: 2,
      matched: 1,
      missed: 1,
      label: 'Q4 2026',
      value: 11.758e9,
    })
    expect(f!.headline).toBe(
      'Anthropic’s 10-K scores 2 press reports of its revenue over 2 periods, a median 4.3% off',
    )
    expect(f!.explanation).toContain(
      'Q4 2026, $11.8B (2026 less First nine months of 2026), against 1 press report a median +6.3% off.',
    )
    expect(f!.explanation).toContain(
      'example.com reported $44 billion on 2027-01-15, 41 days before the filing: −2.2% off 2026, within the 5% tolerance.',
    )
  })

  it('reads one report on one figure as that report’s error', () => {
    const [f] = revenueFindings(ISSUERS, [FY26], NOW)
    expect(f!.headline).toBe(
      'Anthropic revenue, 2026: $45.0B in its 10-K, against $44 billion in the press (−2.2%)',
    )
  })

  it('stays quiet once the filing is older than the window', () => {
    const later = new Date(Date.parse('2027-02-25T00:00:00Z') + (FRESH_DAYS + 1) * 86_400_000)
    expect(revenueFindings(ISSUERS, [FY26, Q4], later)).toEqual([])
  })

  it('writes nothing for a backfill: reports labeled after the filing that scores them', () => {
    // A GDELT archive pass: 60 headlines over two years, every one labeled today. Many are
    // scored, some by the fresh 10-K, and none alerts.
    const today = '2027-03-01T06:00:00.000Z'
    const backfill = [
      ...Array.from({ length: 58 }, (_, i) => {
        const day = new Date(Date.parse('2025-02-01T12:00:00Z') + i * 12 * 86_400_000)
        const amounts = [386e6, 4585e6, 1163e6, 16286e6, 33242e6]
        return headline(day.toISOString(), amounts[i % amounts.length]!, today, {}, i)
      }),
      headline('2027-01-05T12:00:00.000Z', 45e9, today, { period: '2026' }, 58),
      headline('2027-01-08T12:00:00.000Z', 11.9e9, today, {}, 59),
    ]
    const figures = filedFigures(ROWS)
    const scored = backfill.map((h) => scoreReport(h, figures))
    expect(scored.filter((s) => s.filed).length).toBeGreaterThan(5)
    expect(
      scored.some((s) => s.filed?.accession_no === K10),
      'some backfilled reports are scored by the fresh filing',
    ).toBe(true)
    expect(revenueFindings(ISSUERS, backfill, NOW)).toEqual([])
  })

  it('leaves out a report over a year ahead of the filing, a restated one and an open one', () => {
    const early = headline('2025-12-01T12:00:00.000Z', 45e9, '2025-12-01T13:00:00.000Z', {
      period: '2026',
    })
    // Repeats the filed 2025 figure; names a period nothing has filed.
    const restated = headline(
      '2027-01-10T12:00:00.000Z',
      4.6e9,
      '2027-01-10T13:00:00.000Z',
      { period: '2025' },
      2,
    )
    const open = headline(
      '2027-01-12T12:00:00.000Z',
      60e9,
      '2027-01-12T13:00:00.000Z',
      { period: '2027' },
      3,
    )
    expect(revenueFindings(ISSUERS, [early, restated, open], NOW)).toEqual([])
  })
})

const HASH = (n: number) => n.toString(16).padStart(64, '0')
const sourcesYaml = fixtureText('sources.yaml')

const entity = (entity_type: string, entity_key: string, payload: object, n: number) => ({
  source_id: 'prospectus-revenue-anthropic',
  entity_key,
  entity_type,
  provider: 'anthropic',
  content_hash: HASH(n),
  payload: JSON.stringify(payload),
  snapshot_id: HASH(n),
  first_seen_at: '2026-11-02T12:00:00.000Z',
  source_url: `${filingUrl(S1)}doc.htm`,
  fetched_at: '2026-11-02T12:00:00.000Z',
})

async function seed(rows: readonly RevenuePeriod[], headlines: readonly JudgedHeadline[]) {
  await db.insert(schema.entities).values(
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
  )
  // One row a statement: D1 binds at most 100 parameters.
  for (const [i, p] of rows.entries()) {
    await db.insert(schema.entities).values({
      ...entity(
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
          taxonomy: p.basis === 'prospectus' ? 'prospectus' : 'us-gaap',
          unaudited: p.unaudited,
        },
        i + 1,
      ),
      source_url: p.source_url,
      fetched_at: p.fetched_at,
    })
  }
  for (const [i, h] of headlines.entries()) {
    const title_key = h.title.toLowerCase()
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
      judged_at: h.judged_at,
      source_url: h.url,
      fetched_at: h.fetched_at,
    })
  }
}

describe('the revenue-score rule over a seeded store', () => {
  beforeEach(async () => {
    for (const t of [
      schema.alerts,
      schema.changes,
      schema.reportedFigures,
      schema.reportedArticles,
      schema.entities,
    ]) {
      await db.delete(t)
    }
  })

  it('writes one alert for a filing that scored held reports, and not again', async () => {
    await seed(ROWS, [
      FY26,
      Q4,
      // Read back from the archive after the filing: scored on /ground-truth, no alert.
      headline(
        '2027-01-18T12:00:00.000Z',
        45.5e9,
        '2027-02-27T13:00:00.000Z',
        { period: '2026' },
        4,
      ),
    ])
    expect(await writeRevenueScoreAlerts(db, sourcesYaml, NOW)).toEqual({ written: 1, findings: 1 })
    const [alert] = await db.select().from(schema.alerts)
    expect(alert).toMatchObject({ rule: REVENUE_RULE, severity: 'notable' })
    const [change] = await db.select().from(schema.changes)
    expect(change).toMatchObject({
      entity_type: 'revenue_score',
      provider: 'anthropic',
      change_type: 'added',
    })
    expect(JSON.parse(change!.after_json!)).toMatchObject({ reports: 2, accession_no: K10 })
    expect(JSON.parse(alert!.change_ids)).toEqual([change!.id])
    expect((await writeRevenueScoreAlerts(db, sourcesYaml, NOW)).written).toBe(0)
    const nextDay = new Date('2027-03-02T06:00:00Z')
    expect((await writeRevenueScoreAlerts(db, sourcesYaml, nextDay)).written).toBe(0)
  })

  it('writes nothing on a first run over a store of historical reports', async () => {
    // Labeled when published, each held until a registration filing scored it, all
    // filings older than the window.
    const history = Array.from({ length: 30 }, (_, i) => {
      const day = new Date(Date.parse('2025-03-01T12:00:00Z') + i * 20 * 86_400_000)
      const amounts = [1163e6, 4585e6, 16286e6, 33242e6, 2545e6]
      return headline(day.toISOString(), amounts[i % amounts.length]!, day.toISOString(), {}, i)
    })
    await seed(BEFORE_10K, history)
    const at = new Date('2026-11-25T12:00:00Z')
    expect(await writeRevenueScoreAlerts(db, sourcesYaml, at)).toEqual({ written: 0, findings: 0 })
    expect(await db.select().from(schema.alerts)).toEqual([])
  })

  it('keeps its rows from the judge', () => {
    expect(JUDGE_EXCLUDED_ENTITY_TYPES).toContain('revenue_score')
  })
})
