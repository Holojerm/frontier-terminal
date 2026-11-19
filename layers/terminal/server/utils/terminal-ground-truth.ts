// The ground-truth payload (/ground-truth): each press report of a lab's
// revenue against the figure the lab's own filing printed later, with the
// error and how many days the report came before the filing. Beside it, the
// alert track record's totals.
//
// A report is scored only against a figure that was not yet filed when it was
// published. Most headlines name no year, so the period is the nearest
// not-yet-filed figure within TOLERANCE_PCT, and the row says which way it was
// chosen. A quarter no filing prints is one filed period minus another with
// the same start (nine months minus six), public from the later filing.
//
// `found_at` is kept beside `published_at` because the two differ for a
// headline read back from GDELT's archive: the press had it before the filing
// and our store did not.

import type {
  GroundTruthData,
  GroundTruthFiled,
  GroundTruthReport,
  GroundTruthResolution,
  GroundTruthTally,
  GroundTruthWaiting,
  LabId,
  ReportedHeadline,
  ReportedMetric,
  RevenuePeriod,
} from '../../shared/utils/terminal-types'

import type { PipelineDb } from '../pipeline/store'
import type { QueryContext } from './terminal-db'
import { middle, storedHeadlines, type StoredHeadline } from './terminal-reported'
import { queryRevenue } from './terminal-revenue'
import { queryTrackRecord } from './terminal-track-record'

/** A report matches the nearest filed figure within this many percent. */
export const TOLERANCE_PCT = 5

/** Open reports listed. */
export const OPEN_LIMIT = 50

const DAY_MS = 86_400_000
const dayOf = (iso: string) => iso.slice(0, 10)
const utc = (day: string) => Date.parse(`${day}T00:00:00Z`)
const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY_MS)
const dayAfter = (day: string) => new Date(utc(day) + DAY_MS).toISOString().slice(0, 10)
const lastOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
const pad = (n: number) => String(n).padStart(2, '0')
const spanKey = (s: { start: string; end: string }) => `${s.start}|${s.end}`

/** 2025-01-01..2025-12-31 -> 2025; a quarter, half or nine months by name; anything else as its dates. */
export function spanLabel(start: string, end: string): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number]
  const [ey, em, ed] = end.split('-').map(Number) as [number, number, number]
  if (y === ey && d === 1 && ed === lastOfMonth(ey, em)) {
    const months = em - m + 1
    if (months === 12) return String(y)
    if (months === 3 && (m - 1) % 3 === 0) return `Q${(m - 1) / 3 + 1} ${y}`
    if (months === 6 && m === 1) return `First half of ${y}`
    if (months === 6 && m === 7) return `Second half of ${y}`
    if (months === 9 && m === 1) return `First nine months of ${y}`
  }
  return `${start} to ${end}`
}

/** The calendar span a headline's period names: 2025, 2026-Q3, 2026-10. */
export function statedSpan(period: string): { start: string; end: string } | null {
  const m = /^(\d{4})(?:-Q([1-4])|-(\d{2}))?$/.exec(period)
  if (!m) return null
  const year = Number(m[1])
  const [from, to] = m[2]
    ? [Number(m[2]) * 3 - 2, Number(m[2]) * 3]
    : m[3]
      ? [Number(m[3]), Number(m[3])]
      : [1, 12]
  return {
    start: `${year}-${pad(from)}-01`,
    end: `${year}-${pad(to)}-${pad(lastOfMonth(year, to))}`,
  }
}

/**
 * Each period at the filing that first printed it, then the periods no filing
 * prints that two of those give by subtraction. `rows` is every filed row,
 * superseded ones included, since the first filing of a period is one of them.
 */
export function filedFigures(rows: readonly RevenuePeriod[]): GroundTruthFiled[] {
  const first = new Map<string, RevenuePeriod>()
  for (const row of rows) {
    const held = first.get(spanKey(row))
    if (
      !held ||
      row.filed < held.filed ||
      (row.filed === held.filed && row.accession_no < held.accession_no)
    ) {
      first.set(spanKey(row), row)
    }
  }
  const stated: GroundTruthFiled[] = [...first.values()].map((p) => ({
    start: p.start,
    end: p.end,
    days: p.days,
    label: spanLabel(p.start, p.end),
    val: p.val,
    first_filed: p.filed,
    form: p.form,
    accession_no: p.accession_no,
    filing_url: p.filing_url,
    unaudited: p.unaudited,
    derived_from: null,
    source_url: p.source_url,
    fetched_at: p.fetched_at,
  }))

  const derived = new Map<string, GroundTruthFiled>()
  for (const short of stated) {
    for (const long of stated) {
      if (short.start !== long.start || short.end >= long.end) continue
      const start = dayAfter(short.end)
      const val = long.val - short.val
      const key = spanKey({ start, end: long.end })
      if (val <= 0 || first.has(key)) continue
      // Public once both are: the later of the two filings.
      const later = short.first_filed > long.first_filed ? short : long
      const held = derived.get(key)
      if (held && held.first_filed <= later.first_filed) continue
      derived.set(key, {
        start,
        end: long.end,
        days: daysBetween(start, long.end) + 1,
        label: spanLabel(start, long.end),
        val,
        first_filed: later.first_filed,
        form: later.form,
        accession_no: later.accession_no,
        filing_url: later.filing_url,
        unaudited: short.unaudited || long.unaudited,
        derived_from: [long, short].map(({ start, end, val, filing_url }) => ({
          start,
          end,
          val,
          filing_url,
        })),
        source_url: later.source_url,
        fetched_at: later.fetched_at,
      })
    }
  }
  return [...stated, ...derived.values()]
}

const errorPct = (amount: number, filed: number) => ((amount - filed) / filed) * 100

function nearest(
  amount: number,
  figures: readonly GroundTruthFiled[],
): { filed: GroundTruthFiled; error: number } | null {
  let best: { filed: GroundTruthFiled; error: number } | null = null
  for (const filed of figures) {
    const error = errorPct(amount, filed.val)
    if (!best || Math.abs(error) < Math.abs(best.error)) best = { filed, error }
  }
  return best
}

export interface Scored {
  report: GroundTruthReport
  /** The filed figure a matched or missed report was scored against. */
  filed: GroundTruthFiled | null
}

/** One revenue headline against a lab's filed figures. */
export function scoreReport(h: StoredHeadline, figures: readonly GroundTruthFiled[]): Scored {
  const day = dayOf(h.published_at)
  const base = {
    lab: h.lab,
    amount: h.amount,
    amount_text: h.amount_text,
    period: h.period,
    title: h.title,
    outlet: h.outlet,
    url: h.url,
    published_at: h.published_at,
    found_at: h.found_at,
    outlets: h.outlets,
    source_url: h.source_url,
    fetched_at: h.fetched_at,
  }
  const compared = (filed: GroundTruthFiled) => ({
    filed_label: filed.label,
    filed_val: filed.val,
    error_pct: errorPct(h.amount, filed.val),
  })
  const unscored = (
    state: 'restated' | 'open',
    filed: GroundTruthFiled | null,
    matched_by: GroundTruthReport['matched_by'] = null,
  ): Scored => ({
    report: {
      ...base,
      state,
      matched_by,
      ...(filed ? compared(filed) : { filed_label: null, filed_val: null, error_pct: null }),
      lead_days: null,
      held_before_filing: null,
    },
    filed: null,
  })
  const scored = (filed: GroundTruthFiled, matched_by: 'stated' | 'nearest'): Scored => {
    const { error_pct } = compared(filed)
    return {
      report: {
        ...base,
        state: Math.abs(error_pct) <= TOLERANCE_PCT ? 'matched' : 'missed',
        matched_by,
        ...compared(filed),
        lead_days: daysBetween(day, filed.first_filed),
        held_before_filing: dayOf(h.found_at) < filed.first_filed,
      },
      filed,
    }
  }

  const span = h.period ? statedSpan(h.period) : null
  if (span) {
    const target = figures.find((f) => spanKey(f) === spanKey(span))
    if (!target) return unscored('open', null)
    return target.first_filed <= day
      ? unscored('restated', target, 'stated')
      : scored(target, 'stated')
  }

  const within = (n: { error: number } | null) => n !== null && Math.abs(n.error) <= TOLERANCE_PCT
  // A figure already filed can only be repeated. One not yet filed, for a period already over, can be scored.
  const filedBy = nearest(
    h.amount,
    figures.filter((f) => f.first_filed <= day),
  )
  const pending = nearest(
    h.amount,
    figures.filter((f) => f.first_filed > day && f.end < day),
  )
  if (
    filedBy &&
    within(filedBy) &&
    (!pending || Math.abs(filedBy.error) <= Math.abs(pending.error))
  ) {
    return unscored('restated', filedBy.filed, 'nearest')
  }
  if (pending && within(pending)) return scored(pending.filed, 'nearest')
  const closest = nearest(
    h.amount,
    figures.filter((f) => f.end < day),
  )
  return unscored('open', closest?.filed ?? null)
}

/** Scored reports grouped by the filed figure, newest filing first. */
export function resolutionsOf(lab: LabId, scored: readonly Scored[]): GroundTruthResolution[] {
  const groups = new Map<string, { filed: GroundTruthFiled; reports: GroundTruthReport[] }>()
  for (const s of scored) {
    if (!s.filed) continue
    const group = groups.get(spanKey(s.filed)) ?? { filed: s.filed, reports: [] }
    group.reports.push(s.report)
    groups.set(spanKey(s.filed), group)
  }
  return [...groups.values()]
    .map(({ filed, reports }) => {
      reports.sort(
        (a, b) => a.published_at.localeCompare(b.published_at) || a.url.localeCompare(b.url),
      )
      const amounts = reports.map((r) => r.amount)
      const median = middle(amounts)
      return {
        lab,
        filed,
        reports,
        lead_days: reports[0]!.lead_days!,
        median,
        low: Math.min(...amounts),
        high: Math.max(...amounts),
        error_pct: errorPct(median, filed.val),
        held: reports.filter((r) => r.held_before_filing).length,
      }
    })
    .sort(
      (a, b) =>
        b.filed.first_filed.localeCompare(a.filed.first_filed) ||
        b.filed.end.localeCompare(a.filed.end) ||
        a.filed.days - b.filed.days,
    )
}

const METRIC_ORDER: readonly ReportedMetric[] = [
  'revenue',
  'revenue_run_rate',
  'valuation',
  'funding',
  'funding_total',
]

/** Reported figures nothing filed can score, one row per lab, figure and currency. */
export function waitingOf(
  headlines: readonly StoredHeadline[],
  filers: ReadonlySet<LabId>,
): GroundTruthWaiting[] {
  const groups = new Map<string, StoredHeadline[]>()
  for (const h of headlines) {
    if (h.basis !== 'reported') continue
    if (h.metric === 'revenue' && h.currency === 'USD' && filers.has(h.lab)) continue
    const key = `${h.lab}|${h.metric}|${h.currency}`
    groups.set(key, [...(groups.get(key) ?? []), h])
  }
  return [...groups.values()]
    .map((group): GroundTruthWaiting => {
      const { found_at: _found, ...latest } = group.reduce((a, b) =>
        b.published_at > a.published_at ? b : a,
      )
      return {
        lab: latest.lab,
        metric: latest.metric,
        currency: latest.currency,
        reports: group.length,
        latest: latest satisfies ReportedHeadline,
        reason:
          latest.metric === 'revenue' && latest.currency === 'USD' ? 'no-filing' : 'not-in-filings',
      }
    })
    .sort(
      (a, b) =>
        a.lab.localeCompare(b.lab) ||
        METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric) ||
        a.currency.localeCompare(b.currency),
    )
}

export function tallyOf(
  resolutions: readonly GroundTruthResolution[],
  restated: number,
  open: number,
): GroundTruthTally {
  const reports = resolutions.flatMap((r) => r.reports)
  return {
    periods: resolutions.length,
    reports: reports.length,
    missed: reports.filter((r) => r.state === 'missed').length,
    median_abs_error_pct: reports.length
      ? middle(reports.map((r) => Math.abs(r.error_pct!)))
      : null,
    median_lead_days: resolutions.length ? middle(resolutions.map((r) => r.lead_days)) : null,
    held: reports.filter((r) => r.held_before_filing).length,
    restated,
    open,
  }
}

export async function queryGroundTruth(
  db: PipelineDb,
  ctx: QueryContext,
): Promise<GroundTruthData> {
  const [revenue, stored, record] = await Promise.all([
    queryRevenue(db, ctx),
    storedHeadlines(db, ctx.at),
    queryTrackRecord(db, ctx),
  ])

  // Only a lab that files for itself: a parent's consolidated revenue isn't the lab's.
  const issuers = revenue.providers.filter((p) => p.disclosure === 'issuer')
  const filers = new Set(issuers.map((p) => p.provider))

  const resolutions: GroundTruthResolution[] = []
  const open: GroundTruthReport[] = []
  let restated = 0
  for (const issuer of issuers) {
    const figures = filedFigures([...issuer.periods, ...issuer.superseded])
    const scored = stored.headlines
      .filter(
        (h) =>
          h.lab === issuer.provider &&
          h.metric === 'revenue' &&
          h.basis === 'reported' &&
          h.currency === 'USD',
      )
      .map((h) => scoreReport(h, figures))
    resolutions.push(...resolutionsOf(issuer.provider, scored))
    open.push(...scored.filter((s) => s.report.state === 'open').map((s) => s.report))
    restated += scored.filter((s) => s.report.state === 'restated').length
  }
  resolutions.sort((a, b) => b.filed.first_filed.localeCompare(a.filed.first_filed))
  open.sort((a, b) => b.published_at.localeCompare(a.published_at))

  const found = stored.headlines.map((h) => h.found_at).sort()
  return {
    tolerance_pct: TOLERANCE_PCT,
    resolutions,
    open: open.slice(0, OPEN_LIMIT),
    waiting: waitingOf(stored.headlines, filers),
    tally: tallyOf(resolutions, restated, open.length),
    first_stored_at: found[0] ?? null,
    alerts: {
      from: record.from,
      window_days: record.window_days,
      rated: record.rows.length,
      window_open: record.window_open,
      press: record.press,
      newsroom: record.newsroom,
    },
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
  }
}
