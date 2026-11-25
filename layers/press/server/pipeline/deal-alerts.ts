// The deal-score rule: when a new filing scores press reports of a deal's size (the deal half
// of /ground-truth, terminal-ground-truth-deals.ts), one alert per filed figure states the
// figure and how far the reports were from it. A match and a miss read the same: the finding
// is the error. No model in the loop beyond the judge's reading of each headline, which the
// Worker already checked against the headline.
//
// The event is a report moving from open to scored, so a report counts only when
//   - the figure was first filed in the last FRESH_DAYS,
//   - the judge had labeled the report before the day the figure was filed (a headline read
//     back from GDELT's archive, or read again for deals, is scored by filings it already
//     knew about and is the page's, not an alert), and
//   - the report came at most MAX_LEAD_DAYS before the filing.
// A backfill over stored deals therefore alerts on nothing, and one filing that scores many
// headlines is one alert. Restated reports (the press repeating a filed figure) don't alert.
// Ids hash the measure, the figure's period and its accession, so a re-run writes nothing
// twice.

import { and, inArray, ne } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { compactUsd } from '#layers/core/shared/utils/terminal-format'
import { writeFindings, type Finding } from '#layers/core/server/pipeline/observation-alerts'
import type { StoredFact } from '../../../companies/server/exposure/series'

export const DEAL_RULE = 'deal-score-floor' as const

/** How recent the scoring filing must be. */
export const FRESH_DAYS = 14
/** A report further ahead of the filing than this isn't scored by it for the alert. */
export const MAX_LEAD_DAYS = 365
/** Reports named in the explanation before "and N more". */
const LISTED = 3
const DAY_MS = 86_400_000

const dayOf = (iso: string) => iso.slice(0, 10)

type Scored = GroundTruthDeal & { filed: NonNullable<GroundTruthDeal['filed']> }

const pct = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`

/** Pure: the reports a fresh filing moved from open to scored, each with its deal. */
export function freshlyScored(deals: readonly StoredDeal[], ctx: DealContext, now: Date): Scored[] {
  const freshFrom = dayOf(new Date(now.getTime() - FRESH_DAYS * DAY_MS).toISOString())
  return deals
    .filter((d) => d.basis === 'reported')
    .flatMap((d) => {
      const s = scoreDeal(d, ctx)
      if ((s.state !== 'matched' && s.state !== 'missed') || !s.filed) return []
      if (s.filed.first_filed < freshFrom) return []
      if (dayOf(d.judged_at) >= s.filed.first_filed) return []
      if ((s.lead_days ?? Infinity) > MAX_LEAD_DAYS) return []
      return [s as Scored]
    })
}

function reportLine(s: Scored, tolerance: number): string {
  const within = Math.abs(s.error_pct!) <= tolerance ? 'within' : 'outside'
  return `${s.outlet} reported ${s.amount_text} on ${dayOf(s.published_at)}, ${s.lead_days} days before the filing: ${pct(s.error_pct!)} off the filed figure, ${within} the ${tolerance}% tolerance.`
}

function finding(group: readonly Scored[], tolerance: number): Finding {
  // Earliest report first: the one furthest ahead of the filing.
  const reports = [...group].sort(
    (a, b) => a.published_at.localeCompare(b.published_at) || a.url.localeCompare(b.url),
  )
  const first = reports[0]!
  const f = first.filed
  const matched = reports.filter((r) => r.state === 'matched').length
  const median = middle(reports.map((r) => Math.abs(r.error_pct!)))
  const figure = `${f.label}, ${f.period}: ${compactUsd(f.value)} in the filing`
  const headline =
    reports.length === 1
      ? `${figure}, against ${first.amount_text} in the press (${pct(first.error_pct!)})`
      : `${figure}, against ${reports.length} press reports a median ${median.toFixed(1)}% off`
  const listed = reports
    .slice(0, LISTED)
    .map((r) => reportLine(r, tolerance))
    .join(' ')
  const more = reports.length > LISTED ? ` And ${reports.length - LISTED} more.` : ''
  return {
    rule: DEAL_RULE,
    entity_type: 'deal_score',
    entity_key: `deal_score:${first.lab}:${(f.ticker ?? first.lab).toLowerCase()}:${first.metric}`,
    provider: first.lab,
    period: `${f.period}|${f.accession_no}`,
    change_type: 'added',
    before: null,
    after: {
      summary: `${f.filer} · ${f.label} · ${f.period} · ${compactUsd(f.value)} · ${reports.length} press ${reports.length === 1 ? 'report' : 'reports'}`,
      lab: first.lab,
      metric: first.metric,
      filer: f.filer,
      ticker: f.ticker,
      label: f.label,
      period: f.period,
      value: f.value,
      form: f.form,
      filed: f.first_filed,
      accession_no: f.accession_no,
      filing_url: f.filing_url,
      reports: reports.length,
      matched,
      missed: reports.length - matched,
      median_abs_error_pct: Number(median.toFixed(1)),
      earliest_title: first.title,
      earliest_outlet: first.outlet,
      earliest_url: first.url,
      earliest_published_at: first.published_at,
      earliest_amount: first.amount,
      earliest_error_pct: Number(first.error_pct!.toFixed(1)),
      earliest_lead_days: first.lead_days,
    },
    headline,
    explanation: [
      `${f.label}, ${f.period}, is ${compactUsd(f.value)} in ${f.filer}’s ${f.form} filed ${f.first_filed} (accession ${f.accession_no}).`,
      `${listed}${more}`,
      'Which filed figure answers which kind of deal is a fixed table, the one /ground-truth scores with. The press figure is the headline’s, as the judge read it.',
      `Rule-based: reports on file here before a filing from the last ${FRESH_DAYS} days scored them, at most ${MAX_LEAD_DAYS} days ahead of it. No model weighs the comparison.`,
    ].join(' '),
    source_url: f.source_url,
    fetched_at: f.fetched_at,
  }
}

/** Pure: one finding per filed figure that freshly scored reports. */
export function dealFindings(deals: readonly StoredDeal[], ctx: DealContext, now: Date): Finding[] {
  const groups = new Map<string, Scored[]>()
  for (const s of freshlyScored(deals, ctx, now)) {
    const key = [s.lab, s.metric, s.filed.ticker, s.filed.period, s.filed.accession_no].join('|')
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  return [...groups.values()].map((g) => finding(g, ctx.tolerance_pct))
}

/** The filed facts the deal measures read, and nothing else of filed_facts. */
function dealFacts(db: PipelineDb): Promise<StoredFact[]> {
  const concepts = [...new Set(DEAL_MEASURES.flatMap((m) => (m.concept ? [m.concept] : [])))]
  return db
    .select({
      ticker: tables.filedFacts.ticker,
      concept: tables.filedFacts.concept,
      dims: tables.filedFacts.dims,
      start: tables.filedFacts.start,
      end: tables.filedFacts.end,
      value: tables.filedFacts.value,
      unit: tables.filedFacts.unit,
      form: tables.filedFacts.form,
      filed: tables.filedFacts.filed,
      accession_no: tables.filedFacts.accession_no,
      cik: tables.filedFacts.cik,
      source_url: tables.filedFacts.source_url,
      fetched_at: tables.filedFacts.fetched_at,
    })
    .from(tables.filedFacts)
    .where(
      and(
        inArray(tables.filedFacts.concept, concepts),
        ne(tables.filedFacts.basis, 'companyconcept'),
      ),
    )
}

export async function writeDealAlerts(
  db: PipelineDb,
  now = new Date(),
): Promise<{ written: number; findings: number }> {
  const [deals, facts, issuers] = await Promise.all([
    storedDeals(db),
    dealFacts(db),
    labCommitments(db),
  ])
  const findings = dealFindings(
    deals,
    { facts, aggregates: aggregatesOf(issuers), tolerance_pct: TOLERANCE_PCT },
    now,
  )
  return { written: await writeFindings(db, findings, now), findings: findings.length }
}
