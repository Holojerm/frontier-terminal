import { beforeEach, describe, expect, it } from 'vitest'

import type { StoredFact } from '../../companies/server/exposure/series'
import {
  DEAL_RULE,
  FRESH_DAYS,
  dealFindings,
  freshlyScored,
  writeDealAlerts,
} from '../server/pipeline/deal-alerts'
import { scoreDeal } from '../server/utils/terminal-ground-truth-deals'
import type { StoredDeal } from '../server/utils/terminal-reported'
import { TOLERANCE_PCT } from '../../companies/server/utils/terminal-ground-truth-guidance'
import { JUDGE_EXCLUDED_ENTITY_TYPES } from '#layers/core/server/pipeline/judge/pending'

const AMZN = '0001018724'
const ADDED = 'amzn:RevenueRemainingPerformanceObligationAmountPeriodIncreaseDecrease'
const TIMING =
  'us-gaap:RevenueRemainingPerformanceObligationExpectedTimingOfSatisfactionStartDateAxis'

/** What Amazon added to its backlog from Anthropic in one quarter, first filed on `filedOn`. Made up. */
function added(start: string, end: string, value: number, filedOn: string, n: number): StoredFact {
  const accession_no = `0001018724-${filedOn.slice(2, 4)}-${String(n).padStart(6, '0')}`
  return {
    ticker: 'AMZN',
    cik: AMZN,
    concept: ADDED,
    dims: `srt:MajorCustomersAxis=amzn:AnthropicMember;${TIMING}=${end}`,
    start,
    end,
    value,
    unit: 'USD',
    form: '10-Q',
    filed: filedOn,
    accession_no,
    source_url: `https://www.sec.gov/Archives/edgar/data/1018724/${accession_no.replace(/-/g, '')}/x.xml`,
    fetched_at: `${filedOn}T22:00:00.000Z`,
  }
}

function deal(published_at: string, amount: number, judged_at: string, n = 0): StoredDeal {
  const title = `Anthropic commits $${amount / 1e9} billion to AWS ${n}`
  const url = `https://example.com/${n}-${published_at.slice(0, 10)}`
  return {
    lab: 'anthropic',
    basis: 'reported',
    metric: 'commitment',
    counterparty: 'AWS',
    currency: 'USD',
    amount,
    amount_text: `$${amount / 1e9} billion`,
    title,
    outlet: 'example.com',
    url,
    published_at,
    outlets: 1,
    source_url: url,
    fetched_at: published_at,
    found_at: published_at,
    judged_at,
  }
}

// Q3 2026: Amazon's 10-Q of 2026-10-30 states $100B added. Earlier quarters back to 2024.
const Q3 = added('2026-07-01', '2026-09-30', 100e9, '2026-10-30', 40)
const HISTORY: StoredFact[] = [
  Q3,
  ...Array.from({ length: 10 }, (_, i) => {
    const year = 2024 + Math.floor(i / 4)
    const q = (i % 4) + 1
    const start = `${year}-${String(q * 3 - 2).padStart(2, '0')}-01`
    const end = `${year}-${String(q * 3).padStart(2, '0')}-${q === 1 || q === 4 ? 31 : 30}`
    const nextQ = q === 4 ? `${year + 1}-01-30` : `${year}-${String(q * 3 + 1).padStart(2, '0')}-30`
    return added(start, end, (10 + i) * 1e9, nextQ, i + 1)
  }),
]
const CTX = { facts: HISTORY, aggregates: [], tolerance_pct: TOLERANCE_PCT }
const NOW = new Date('2026-11-02T12:00:00Z')

describe('the deal-score rule, pure', () => {
  it('alerts once per filed figure on reports it held open, a match and a miss alike', () => {
    const deals = [
      deal('2026-08-10T12:00:00.000Z', 100e9, '2026-08-10T13:00:00.000Z', 1),
      deal('2026-09-02T12:00:00.000Z', 125e9, '2026-09-02T13:00:00.000Z', 2),
    ]
    expect(freshlyScored(deals, CTX, NOW).map((s) => s.state)).toEqual(['matched', 'missed'])
    const findings = dealFindings(deals, CTX, NOW)
    expect(findings).toHaveLength(1)
    const [f] = findings
    expect(f).toMatchObject({
      rule: DEAL_RULE,
      entity_type: 'deal_score',
      entity_key: 'deal_score:anthropic:amzn:commitment',
      provider: 'anthropic',
      period: `Q3 2026|${Q3.accession_no}`,
      source_url: Q3.source_url,
      fetched_at: Q3.fetched_at,
    })
    expect(f!.after).toMatchObject({ reports: 2, matched: 1, missed: 1, value: 100e9 })
    expect(f!.headline).toBe(
      'Commitment Anthropic added to Amazon’s backlog, Q3 2026: $100B in the filing, against 2 press reports a median 12.5% off',
    )
    expect(f!.explanation).toContain(
      'example.com reported $100 billion on 2026-08-10, 81 days before the filing: 0.0% off the filed figure, within the 5% tolerance.',
    )
    expect(f!.explanation).toContain('+25.0% off the filed figure, outside the 5% tolerance.')
  })

  it('reads one report as that report’s error', () => {
    const [f] = dealFindings(
      [deal('2026-08-10T12:00:00.000Z', 90e9, '2026-08-10T13:00:00.000Z')],
      CTX,
      NOW,
    )
    expect(f!.headline).toBe(
      'Commitment Anthropic added to Amazon’s backlog, Q3 2026: $100B in the filing, against $90 billion in the press (−10.0%)',
    )
  })

  it('stays quiet once the filing is older than the window', () => {
    const later = new Date(Date.parse('2026-10-30T00:00:00Z') + (FRESH_DAYS + 1) * 86_400_000)
    const deals = [deal('2026-08-10T12:00:00.000Z', 100e9, '2026-08-10T13:00:00.000Z')]
    expect(dealFindings(deals, CTX, later)).toEqual([])
  })

  it('writes nothing for a backfill: reports labeled after the filing that scores them', () => {
    // A GDELT archive pass, or the judge reading old headlines again for deals: 60 reports over
    // two years, every one labeled today. Each is scored by a filing it came before, including
    // the fresh Q3 10-Q, and none alerts.
    const today = '2026-11-02T06:00:00.000Z'
    const backfill = Array.from({ length: 60 }, (_, i) => {
      const day = new Date(Date.parse('2024-02-01T12:00:00Z') + i * 16 * 86_400_000)
      return deal(day.toISOString(), (10 + (i % 12)) * 1e9, today, i)
    })
    const scored = backfill.map((d) => scoreDeal(d, CTX))
    expect(
      scored.filter((s) => s.state === 'matched' || s.state === 'missed').length,
    ).toBeGreaterThan(20)
    expect(
      scored.some((s) => s.filed?.accession_no === Q3.accession_no),
      'some backfilled reports are scored by the fresh filing',
    ).toBe(true)
    expect(dealFindings(backfill, CTX, NOW)).toEqual([])
  })

  it('leaves out a report more than a year ahead of the filing, and anything not scored', () => {
    const facts = [added('2025-07-01', '2026-09-30', 100e9, '2026-10-30', 41)]
    const ctx = { ...CTX, facts }
    expect(
      dealFindings([deal('2025-08-10T12:00:00.000Z', 100e9, '2025-08-10T13:00:00.000Z')], ctx, NOW),
    ).toEqual([])
    // Restated (the press repeating Q2's filed $19B) and open (no figure yet) never alert.
    const restated = deal('2026-08-01T12:00:00.000Z', 19e9, '2026-08-01T13:00:00.000Z', 1)
    const open = deal('2026-10-20T12:00:00.000Z', 100e9, '2026-10-20T13:00:00.000Z', 2)
    const before = { ...CTX, facts: HISTORY.filter((f) => f !== Q3) }
    expect([restated, open].map((d) => scoreDeal(d, before).state)).toEqual(['restated', 'open'])
    expect(dealFindings([restated, open], before, NOW)).toEqual([])
  })
})

const HASH = (n: number) => n.toString(16).padStart(64, '0')

async function seed(deals: readonly StoredDeal[], facts: readonly StoredFact[]) {
  for (const [i, d] of deals.entries()) {
    const title_key = d.title.toLowerCase()
    await db.insert(schema.reportedArticles).values({
      id: HASH(100 + i),
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
    await db.insert(schema.reportedFigures).values({
      id: HASH(200 + i),
      title_key,
      article_id: HASH(100 + i),
      lab: d.lab,
      metric: d.metric,
      basis: d.basis,
      counterparty: d.counterparty,
      currency: d.currency,
      amount: d.amount,
      amount_text: d.amount_text,
      period: null,
      published_at: d.published_at,
      judged_at: d.judged_at,
      source_url: d.url,
      fetched_at: d.fetched_at,
    })
  }
  for (const [i, f] of facts.entries()) {
    await db.insert(schema.filedFacts).values({
      id: HASH(300 + i),
      ticker: f.ticker,
      cik: f.cik,
      concept: f.concept,
      dims: f.dims,
      start: f.start,
      end: f.end,
      value: f.value,
      unit: f.unit,
      form: f.form,
      filed: f.filed,
      accession_no: f.accession_no,
      basis: 'instance',
      raw_key: `filed-facts/${f.accession_no}.xml`,
      first_seen_at: f.fetched_at,
      source_url: f.source_url,
      fetched_at: f.fetched_at,
    })
  }
}

describe('the deal-score rule over a seeded store', () => {
  beforeEach(async () => {
    for (const t of [
      schema.alerts,
      schema.changes,
      schema.reportedFigures,
      schema.reportedArticles,
      schema.filedFacts,
      schema.entities,
    ]) {
      await db.delete(t)
    }
  })

  it('writes one alert for a filing that scored held reports, and not again', async () => {
    await seed(
      [
        deal('2026-08-10T12:00:00.000Z', 100e9, '2026-08-10T13:00:00.000Z', 1),
        deal('2026-09-02T12:00:00.000Z', 125e9, '2026-09-02T13:00:00.000Z', 2),
        // Read back from the archive today: scored on /ground-truth, no alert.
        deal('2026-08-20T12:00:00.000Z', 101e9, '2026-11-01T13:00:00.000Z', 3),
      ],
      HISTORY,
    )
    expect(await writeDealAlerts(db, NOW)).toEqual({ written: 1, findings: 1 })
    const [alert] = await db.select().from(schema.alerts)
    expect(alert).toMatchObject({ rule: DEAL_RULE, severity: 'notable' })
    const [change] = await db.select().from(schema.changes)
    expect(change).toMatchObject({
      entity_type: 'deal_score',
      provider: 'anthropic',
      change_type: 'added',
    })
    expect(JSON.parse(change!.after_json!)).toMatchObject({ reports: 2 })
    expect((await writeDealAlerts(db, NOW)).written).toBe(0)
    expect((await writeDealAlerts(db, new Date('2026-11-03T06:00:00Z'))).written).toBe(0)
  })

  it('writes nothing on a first run over a store of historical deals', async () => {
    const deals = Array.from({ length: 40 }, (_, i) => {
      const day = new Date(Date.parse('2024-02-01T12:00:00Z') + i * 18 * 86_400_000)
      // Labeled when they were published: each was open until its quarter's 10-Q.
      return deal(day.toISOString(), (10 + (i % 12)) * 1e9, day.toISOString(), i)
    })
    await seed(
      deals,
      HISTORY.filter((f) => f !== Q3),
    )
    expect(await writeDealAlerts(db, NOW)).toEqual({ written: 0, findings: 0 })
    expect(await db.select().from(schema.alerts)).toEqual([])
  })

  it('keeps its rows from the judge', () => {
    expect(JUDGE_EXCLUDED_ENTITY_TYPES).toContain('deal_score')
  })
})
