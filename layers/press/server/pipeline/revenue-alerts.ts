// The revenue-score rule: when a lab's own new filing scores press reports of its revenue (the
// revenue half of /ground-truth, `scoreReport` and `resolutionsOf`), one alert per filing states
// each filed figure and how far the reports were from it. A match and a miss read the same: the
// finding is the error. Only a lab that files for itself counts (`disclosure: 'issuer'`): a
// parent's consolidated revenue isn't the lab's.
//
// The flood guard is the deal-score rule's (deal-alerts.ts). A report counts only when
//   - the figure was first filed in the last FRESH_DAYS,
//   - the judge had labeled the report before the day the figure was filed (a headline read
//     back from GDELT's archive is scored by filings it already knew about and is the page's,
//     not an alert), and
//   - the report came at most MAX_LEAD_DAYS before the filing.
// A backfill alerts on nothing, the rule's first run alerts only on a filing from its last 14
// days, and one filing that scores many headlines over several periods is one alert. Restated
// reports (the press repeating a filed figure) don't alert. Ids hash the lab and the accession,
// so a re-run writes nothing twice.

import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { compactUsd } from '#layers/core/shared/utils/terminal-format'
import { writeFindings, type Finding } from '#layers/core/server/pipeline/observation-alerts'
import { FRESH_DAYS, MAX_LEAD_DAYS } from './deal-alerts'

export const REVENUE_RULE = 'revenue-score-floor' as const

/** Reports named in the explanation before "and N more". */
const LISTED = 3
const DAY_MS = 86_400_000

const dayOf = (iso: string) => iso.slice(0, 10)
const pct = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`

/** A lab that files its own revenue, with every filed row, superseded ones included. */
export interface RevenueIssuer {
  provider: LabId
  rows: readonly RevenuePeriod[]
}

/** Pure: per issuer, the filed figures a fresh filing scored held reports against. */
export function freshResolutions(
  issuers: readonly RevenueIssuer[],
  headlines: readonly JudgedHeadline[],
  now: Date,
): GroundTruthResolution[] {
  const freshFrom = dayOf(new Date(now.getTime() - FRESH_DAYS * DAY_MS).toISOString())
  return issuers.flatMap(({ provider, rows }) => {
    const figures = filedFigures(rows)
    const scored = headlines
      .filter((h) => h.lab === provider && h.metric === 'revenue' && h.basis === 'reported')
      .filter((h) => h.currency === 'USD')
      .flatMap((h) => {
        const s = scoreReport(h, figures)
        // Only a matched or missed report carries the figure that scored it.
        if (!s.filed) return []
        if (s.filed.first_filed < freshFrom) return []
        if (dayOf(h.judged_at) >= s.filed.first_filed) return []
        if ((s.report.lead_days ?? Infinity) > MAX_LEAD_DAYS) return []
        return [s]
      })
    return resolutionsOf(provider, scored)
  })
}

function reportLine(r: GroundTruthReport, tolerance: number): string {
  const within = Math.abs(r.error_pct!) <= tolerance ? 'within' : 'outside'
  return `${r.outlet} reported ${r.amount_text} on ${dayOf(r.published_at)}, ${r.lead_days} days before the filing: ${pct(r.error_pct!)} off ${r.filed_label}, ${within} the ${tolerance}% tolerance.`
}

function figureLine(g: GroundTruthResolution): string {
  const [long, short] = g.filed.derived_from ?? []
  const derived =
    long && short
      ? ` (${spanLabel(long.start, long.end)} less ${spanLabel(short.start, short.end)})`
      : ''
  const n = g.reports.length
  return `${g.filed.label}, ${compactUsd(g.filed.val)}${derived}, against ${n} press ${n === 1 ? 'report' : 'reports'} a median ${pct(g.error_pct)} off.`
}

function finding(group: readonly GroundTruthResolution[], tolerance: number): Finding {
  // resolutionsOf's order: within one filing, the later period first, then the shorter.
  const lead = group[0]!
  const f = lead.filed
  const lab = lead.lab
  const name = PROVIDER_DISPLAY[lab]
  const reports = group
    .flatMap((g) => g.reports)
    .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.url.localeCompare(b.url))
  const first = reports[0]!
  const matched = reports.filter((r) => r.state === 'matched').length
  const median = middle(reports.map((r) => Math.abs(r.error_pct!)))
  const headline =
    group.length > 1
      ? `${name}’s ${f.form} scores ${reports.length} press reports of its revenue over ${group.length} periods, a median ${median.toFixed(1)}% off`
      : reports.length === 1
        ? `${name} revenue, ${f.label}: ${compactUsd(f.val)} in its ${f.form}, against ${first.amount_text} in the press (${pct(first.error_pct!)})`
        : `${name} revenue, ${f.label}: ${compactUsd(f.val)} in its ${f.form}, against ${reports.length} press reports a median ${median.toFixed(1)}% off`
  const listed = reports
    .slice(0, LISTED)
    .map((r) => reportLine(r, tolerance))
    .join(' ')
  const more = reports.length > LISTED ? ` And ${reports.length - LISTED} more.` : ''
  return {
    rule: REVENUE_RULE,
    entity_type: 'revenue_score',
    entity_key: `revenue_score:${lab}`,
    provider: lab,
    period: f.accession_no,
    change_type: 'added',
    before: null,
    after: {
      summary: `${name} · ${f.form} filed ${f.first_filed} · ${group.length} ${group.length === 1 ? 'period' : 'periods'} · ${reports.length} press ${reports.length === 1 ? 'report' : 'reports'}`,
      lab,
      form: f.form,
      filed: f.first_filed,
      accession_no: f.accession_no,
      filing_url: f.filing_url,
      periods: group.length,
      reports: reports.length,
      matched,
      missed: reports.length - matched,
      median_abs_error_pct: Number(median.toFixed(1)),
      label: f.label,
      start: f.start,
      end: f.end,
      value: f.val,
      label_reports: lead.reports.length,
      label_median: lead.median,
      label_error_pct: Number(lead.error_pct.toFixed(1)),
      earliest_title: first.title,
      earliest_outlet: first.outlet,
      earliest_url: first.url,
      earliest_published_at: first.published_at,
      earliest_amount: first.amount,
      earliest_period: first.filed_label,
      earliest_error_pct: Number(first.error_pct!.toFixed(1)),
      earliest_lead_days: first.lead_days,
    },
    headline,
    explanation: [
      `${name}’s ${f.form} filed ${f.first_filed} (accession ${f.accession_no}) first prints:`,
      group.map(figureLine).join(' '),
      `${listed}${more}`,
      'A report names its period or is scored against the nearest figure not yet filed, the way /ground-truth scores it. The press figure is the headline’s, as the judge read it.',
      `Rule-based: reports on file here before a filing from the last ${FRESH_DAYS} days scored them, at most ${MAX_LEAD_DAYS} days ahead of it. No model weighs the comparison.`,
    ].join(' '),
    source_url: f.source_url,
    fetched_at: f.fetched_at,
  }
}

/** Pure: one finding per lab filing that freshly scored reports. */
export function revenueFindings(
  issuers: readonly RevenueIssuer[],
  headlines: readonly JudgedHeadline[],
  now: Date,
): Finding[] {
  const groups = new Map<string, GroundTruthResolution[]>()
  for (const g of freshResolutions(issuers, headlines, now)) {
    const key = `${g.lab}|${g.filed.accession_no}`
    groups.set(key, [...(groups.get(key) ?? []), g])
  }
  return [...groups.values()].map((g) => finding(g, TOLERANCE_PCT))
}

export async function writeRevenueScoreAlerts(
  db: PipelineDb,
  sourcesYaml: string,
  now = new Date(),
): Promise<{ written: number; findings: number }> {
  const [revenue, headlines] = await Promise.all([
    queryRevenue(db, queryContext(sourcesYaml, null, () => now)),
    storedRevenueHeadlines(db),
  ])
  const issuers = revenue.providers
    .filter((p) => p.disclosure === 'issuer')
    .map((p) => ({ provider: p.provider, rows: [...p.periods, ...p.superseded] }))
  const findings = revenueFindings(issuers, headlines, now)
  return { written: await writeFindings(db, findings, now), findings: findings.length }
}
