import { like } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  AlertRow,
  OfferingRow,
  RevenueRow,
  RiskFactorsRow,
  contentHash,
  type ChangeRow,
} from './contracts'
import { registrationTarget } from './parsers/sec/filing-index'
import { riskFactorChanges, type RiskFactorChange } from './parsers/sec/prospectus-risk-factors'
import type { PipelineDb } from './store'

// The prospectus-floor rule: a lab's new registration filing, once its
// document is parsed, always alerts with what the filing says — the period
// its financials now run to, revenue for it, and the price range or price on
// its cover — set against the lab's previous registration filing. No model in
// the loop.
//
// The s1-floor alert fires the moment the filing is listed and can only say
// that it exists. This one follows within two edgar ticks (the filing index,
// then the document) and carries the substance — including which risk-factor
// headings an amendment added or removed against the filing before it. When
// the headings arrive on their own (a document read again after the lane
// learned to read them), they alert on their own, and only if a heading was
// added or removed: a reworded heading is recorded, not announced.
//
// A filing older than FRESH_DAYS never alerts: a registration source derived
// for a filing the store had not seen (a new derived template, a newly
// resolved lab's back catalogue) is history, not news.

export const PROSPECTUS_FLOOR_RULE = 'prospectus-floor' as const
export const FRESH_DAYS = 14

/** True when a registration filing is recent enough that its first parse is news. */
export function freshFiling(filed: string, fetchedAt: string): boolean {
  return Date.parse(fetchedAt) - Date.parse(`${filed}T00:00:00Z`) <= FRESH_DAYS * 86_400_000
}

/** For a derived prospectus-revenue key: is the filing it names fresh? */
export function freshRegistrationKey(key: string | null, fetchedAt: string): boolean {
  if (!key) return false
  return freshFiling(registrationTarget(key).filed, fetchedAt)
}

const SPAN_WORDS: Readonly<Record<number, string>> = {
  3: 'three months',
  6: 'six months',
  9: 'nine months',
  12: 'year',
}

function months(row: Pick<RevenueRow, 'start' | 'end'>): number {
  const [sy, sm] = row.start.split('-').map(Number)
  const [ey, em] = row.end.split('-').map(Number)
  return (ey! - sy!) * 12 + (em! - sm!) + 1
}

/** "the nine months ended 2026-09-30" / "the year ended 2025-12-31". */
function periodLabel(row: Pick<RevenueRow, 'start' | 'end'>): string {
  const n = months(row)
  return `the ${SPAN_WORDS[n] ?? `${n} months`} ended ${row.end}`
}

/** USD in the filing's own unit: "$33,242 million" when whole millions, else dollars. */
export function usd(val: number): string {
  return val % 1_000_000 === 0
    ? `$${(val / 1_000_000).toLocaleString('en-US')} million`
    : `$${val.toLocaleString('en-US')}`
}

const price = (n: number) => `$${n.toFixed(2)}`

/** The newest period, longest span first when two end together. */
function latest(rows: readonly RevenueRow[]): RevenueRow | undefined {
  return [...rows].sort((a, b) =>
    a.end !== b.end ? (a.end < b.end ? 1 : -1) : months(b) - months(a),
  )[0]
}

/** The same span, one year earlier, in the same filing. */
function yearAgo(rows: readonly RevenueRow[], row: RevenueRow): RevenueRow | undefined {
  const shift = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`
  return rows.find((r) => r.start === shift(row.start) && r.end === shift(row.end))
}

function formLabel(o: Pick<OfferingRow, 'form' | 'amendment_no'>): string {
  return o.amendment_no ? `${o.form} (Amendment No. ${o.amendment_no})` : o.form
}

function terms(o: OfferingRow): string {
  if (o.price !== null) return `priced at ${price(o.price)} per share`
  if (o.price_low !== null && o.price_high !== null) {
    return `price range ${price(o.price_low)} to ${price(o.price_high)} per share`
  }
  return 'price range still blank'
}

/** Why this filing matters for the offering's timing — fixed copy per cover state. */
function stage(o: OfferingRow, prev: OfferingRow | null): string {
  if (o.price !== null || o.form === '424B4') {
    return 'A 424B4 is the final prospectus: the offering has priced.'
  }
  if (o.price_low !== null) {
    const was =
      prev && prev.price_low !== null
        ? `The range moved from ${price(prev.price_low)} to ${price(prev.price_high!)} in the ${formLabel(prev)} of ${prev.filed}. `
        : prev
          ? `The ${formLabel(prev)} of ${prev.filed} left it blank. `
          : ''
    return (
      `${was}A price range is what an IPO's roadshow launches on; ` +
      'the next registration filing to watch for is the 424B4 final prospectus, which states the price.'
    )
  }
  return (
    'With the range still blank the roadshow has not launched; ' +
    'the amendment that sets a price range is the next step to watch for.'
  )
}

/** True when the cover states a price or range the prior filing's did not. */
function termsMoved(o: OfferingRow | null, prev: OfferingRow | null): boolean {
  if (!o) return false
  return (
    o.price !== (prev?.price ?? null) ||
    o.price_low !== (prev?.price_low ?? null) ||
    o.price_high !== (prev?.price_high ?? null)
  )
}

/** One registration filing as its document's rows describe it. */
interface Filing {
  cik: string
  entity_name: string
  accession_no: string
  form: string
  filed: string
  offering: OfferingRow | null
  revenue: RevenueRow[]
  risk: RiskFactorsRow | null
}

const label = (f: Filing) => (f.offering ? formLabel(f.offering) : f.form)

/** The lab's previous registration filing in the store, by filing date. */
async function priorFiling(db: PipelineDb, filing: Filing): Promise<Filing | null> {
  const rows = await db
    .select({
      type: tables.entities.entity_type,
      payload: tables.entities.payload,
      source_url: tables.entities.source_url,
      fetched_at: tables.entities.fetched_at,
    })
    .from(tables.entities)
    .where(like(tables.entities.source_id, 'prospectus-revenue-%'))
  const byAccession = new Map<string, Filing>()
  for (const row of rows) {
    // A payload holds the row minus its provenance, which lives in the columns.
    const p: Record<string, unknown> = {
      ...(JSON.parse(row.payload) as Record<string, unknown>),
      source_url: row.source_url,
      fetched_at: row.fetched_at,
    }
    if (p.cik !== filing.cik || p.accession_no === filing.accession_no) continue
    if (typeof p.filed !== 'string' || p.filed > filing.filed) continue
    const offering = row.type === 'offering' ? OfferingRow.parse(p) : null
    const revenue = row.type === 'revenue' ? RevenueRow.parse(p) : null
    const risk = row.type === 'risk_factors' ? RiskFactorsRow.parse(p) : null
    const head = offering ?? revenue ?? risk
    if (!head) continue
    const entry = byAccession.get(head.accession_no) ?? {
      cik: head.cik,
      entity_name: head.entity_name,
      accession_no: head.accession_no,
      form: head.form,
      filed: head.filed,
      offering: null,
      revenue: [],
      risk: null,
    }
    if (offering) entry.offering = offering
    if (revenue) entry.revenue.push(revenue)
    if (risk) entry.risk = risk
    byAccession.set(head.accession_no, entry)
  }
  const sorted = [...byAccession.values()].sort((a, b) =>
    a.filed !== b.filed ? (a.filed < b.filed ? 1 : -1) : a.accession_no < b.accession_no ? 1 : -1,
  )
  return sorted[0] ?? null
}

function parseRow<T>(schema: { parse: (v: unknown) => T }, change: ChangeRow): T {
  return schema.parse({
    ...(JSON.parse(change.after_json!) as Record<string, unknown>),
    source_url: change.source_url,
    fetched_at: change.fetched_at,
  })
}

/** This tick's added prospectus rows, grouped into the filings they come from. */
function addedFilings(changes: readonly ChangeRow[]): { filing: Filing; changes: ChangeRow[] }[] {
  const out = new Map<string, { filing: Filing; changes: ChangeRow[] }>()
  for (const change of changes) {
    if (change.change_type !== 'added' || !change.after_json) continue
    let offering: OfferingRow | null = null
    let revenue: RevenueRow | null = null
    let risk: RiskFactorsRow | null = null
    if (change.entity_type === 'offering') offering = parseRow(OfferingRow, change)
    else if (change.entity_type === 'risk_factors') risk = parseRow(RiskFactorsRow, change)
    else if (change.entity_type === 'revenue') {
      revenue = parseRow(RevenueRow, change)
      if (revenue.taxonomy !== 'prospectus') continue
    } else continue
    const head = (offering ?? revenue ?? risk)!
    const entry = out.get(head.accession_no) ?? {
      filing: {
        cik: head.cik,
        entity_name: head.entity_name,
        accession_no: head.accession_no,
        form: head.form,
        filed: head.filed,
        offering: null,
        revenue: [],
        risk: null,
      },
      changes: [],
    }
    if (offering) entry.filing.offering = offering
    if (revenue) entry.filing.revenue.push(revenue)
    if (risk) entry.filing.risk = risk
    entry.changes.push(change)
    out.set(head.accession_no, entry)
  }
  return [...out.values()]
}

const quote = (h: string) => `“${h}”`

/** One sentence on what the risk-factor headings did against the previous filing. */
export function riskSentence(
  changes: readonly RiskFactorChange[],
  count: number,
  priorLabel: string,
): string {
  const added = changes.filter((c) => c.kind === 'added')
  const removed = changes.filter((c) => c.kind === 'removed')
  const reworded = changes.filter((c) => c.kind === 'reworded')
  if (!changes.length)
    return `Its ${count} risk-factor headings are unchanged from the ${priorLabel}.`
  const parts = [
    added.length ? `added ${added.map((c) => quote(c.heading)).join('; ')}` : null,
    removed.length ? `removed ${removed.map((c) => quote(c.heading)).join('; ')}` : null,
    reworded.length ? `reworded ${reworded.length}` : null,
  ].filter(Boolean)
  return `Against the ${priorLabel}, its ${count} risk-factor headings ${parts.join('; ')}.`
}

const headingCount = (r: RiskFactorsRow) => r.sections.reduce((n, s) => n + s.headings.length, 0)

export async function prospectusFloorAlerts(
  db: PipelineDb,
  changes: readonly ChangeRow[],
): Promise<AlertRow[]> {
  const alerts: AlertRow[] = []
  for (const { filing, changes: cited } of addedFilings(changes)) {
    const first = cited[0]!
    if (!freshFiling(filing.filed, first.fetched_at)) continue
    const o = filing.offering
    const now = latest(filing.revenue)
    const prior = await priorFiling(db, filing)
    const before = prior ? latest(prior.revenue) : undefined
    const priorLabel = prior ? `${label(prior)} of ${prior.filed}` : null
    const risk =
      filing.risk && prior?.risk && priorLabel ? riskFactorChanges(prior.risk, filing.risk) : null

    if (!o && !now) {
      // The headings on their own: news only when one was added or removed.
      if (!risk?.some((c) => c.kind !== 'reworded')) continue
      const added = risk.filter((c) => c.kind === 'added').length
      const removed = risk.filter((c) => c.kind === 'removed').length
      alerts.push(
        AlertRow.parse({
          id: contentHash({
            rule: PROSPECTUS_FLOOR_RULE,
            accession_no: filing.accession_no,
            part: 'risk_factors',
          }),
          severity: 'notable',
          headline: `${filing.entity_name} ${label(filing)}: ${added} risk factor${added === 1 ? '' : 's'} added, ${removed} removed against the ${priorLabel}`,
          explanation:
            `${filing.entity_name} filed ${label(filing)} on ${filing.filed} (accession ${filing.accession_no}). ` +
            riskSentence(risk, headingCount(filing.risk!), priorLabel!),
          change_ids: JSON.stringify(cited.map((c) => c.id).sort()),
          rule: PROSPECTUS_FLOOR_RULE,
          created_at: first.detected_at,
          source_url: first.source_url,
          fetched_at: first.fetched_at,
        }),
      )
      continue
    }

    const sentences: string[] = [
      `${filing.entity_name} filed ${label(filing)} on ${filing.filed} (accession ${filing.accession_no}).`,
    ]
    if (now) {
      const ago = yearAgo(filing.revenue, now)
      sentences.push(
        `Its statement of operations runs to ${now.end}: ${now.tag.toLowerCase()} ${usd(now.val)} for ${periodLabel(now)}` +
          (ago ? `, against ${usd(ago.val)} a year earlier` : '') +
          (now.unaudited ? ' (unaudited).' : '.'),
      )
      if (before && before.end !== now.end) {
        sentences.push(
          `The ${priorLabel} ran to ${before.end}, at ${usd(before.val)} for ${periodLabel(before)}.`,
        )
      } else if (before) {
        sentences.push(`The ${priorLabel} ran to the same period.`)
      }
    }
    if (o?.exchange && o.symbol) {
      sentences.push(`The cover lists the ${o.exchange} under the symbol “${o.symbol}”.`)
    }
    if (o) sentences.push(`Cover: ${terms(o)}.`, stage(o, prior?.offering ?? null))
    if (risk) sentences.push(riskSentence(risk, headingCount(filing.risk!), priorLabel!))
    const headline = [
      `${filing.entity_name} ${label(filing)}`,
      [
        now ? `${usd(now.val)} ${now.tag.toLowerCase()} for ${periodLabel(now)}` : null,
        o ? terms(o) : null,
      ]
        .filter(Boolean)
        .join('; '),
    ]
      .filter(Boolean)
      .join(': ')

    const source = cited.find((c) => c.entity_type === 'offering') ?? first
    // Critical only for what a filing changes: new terms on the cover, or
    // financials through a later period. A first filing has nothing to change
    // against, and its s1-floor alert is already the critical one.
    const newPeriod = now !== undefined && (!before || before.end !== now.end)
    const changed = prior !== null && (termsMoved(o, prior.offering) || newPeriod)
    alerts.push(
      AlertRow.parse({
        id: contentHash({ rule: PROSPECTUS_FLOOR_RULE, accession_no: filing.accession_no }),
        severity: changed ? 'critical' : 'notable',
        headline,
        explanation: sentences.join(' '),
        change_ids: JSON.stringify(cited.map((c) => c.id).sort()),
        rule: PROSPECTUS_FLOOR_RULE,
        created_at: source.detected_at,
        source_url: source.source_url,
        fetched_at: source.fetched_at,
      }),
    )
  }
  return alerts
}
