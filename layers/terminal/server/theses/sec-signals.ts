// Disclosed-revenue growth, read from the periods the revenue axis shows
// (terminal-revenue.ts): the newest filing's value per period, restatements
// applied, so a claim reads the same figures the /revenue page prints.

import type { LabId, RevenuePeriod } from '../../shared/utils/terminal-types'

import type { PipelineDb } from '../pipeline/store'
import { queryContext } from '../utils/terminal-db'
import { queryRevenue } from '../utils/terminal-revenue'
import type { SignalDeps, SignalReading } from './signals'

const DAY_MS = 86_400_000
const dayOf = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS
const round = (n: number) => Math.round(n * 10_000) / 10_000

type Period = Pick<
  RevenuePeriod,
  | 'start'
  | 'end'
  | 'days'
  | 'val'
  | 'form'
  | 'filed'
  | 'filing_url'
  | 'unaudited'
  | 'source_url'
  | 'fetched_at'
>

/** A filed span reads as a quarter at 80–100 days, as the revenue recipes and the exposure series read it. */
const isQuarter = (days: number) => days >= 80 && days <= 100

const nextDay = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)

interface Quarter {
  start: string
  end: string
  val: number
  /** The filed period the value is read from. */
  from: Period
  /** For a quarter derived from year-to-date figures: the shorter span subtracted. */
  less: Period | null
}

/**
 * One quarter per period end: a three-month span as filed, else the
 * year-to-date figure less the one a quarter shorter from the same start
 * (Q4 is the year less nine months), the derivation the exposure series and
 * the revenue recipes use.
 */
function quarters(periods: readonly Period[]): Map<string, Quarter> {
  const out = new Map<string, Quarter>()
  for (const p of periods) {
    if (isQuarter(p.days) && !out.has(p.end)) {
      out.set(p.end, { start: p.start, end: p.end, val: p.val, from: p, less: null })
    }
  }
  for (const p of periods) {
    if (out.has(p.end) || p.days <= 100) continue
    const shorter = periods
      .filter((b) => b.start === p.start && b.end < p.end && isQuarter(dayOf(p.end) - dayOf(b.end)))
      .sort((a, b) => (a.end < b.end ? 1 : -1))[0]
    if (!shorter) continue
    out.set(p.end, {
      start: nextDay(shorter.end),
      end: p.end,
      val: p.val - shorter.val,
      from: p,
      less: shorter,
    })
  }
  return out
}

const yearBefore = (end: string) => (b: { end: string }) =>
  Math.abs(dayOf(b.end) - (dayOf(end) - 365)) <= 21

/**
 * Each quarter against the quarter ending a year earlier. Consecutive filings
 * report different spans (a quarter, a half, nine months), and a run of
 * "straight periods" read across them compared unlike things; so a reading
 * counts only when both sides are quarters, as filed or derived. A period
 * end with no such pair still gets its same-length year-on-year figure, for
 * the record, carrying a void_reason: the rules skip it and never count it
 * as a period.
 */
export function revenueGrowth(periods: readonly Period[]): SignalReading[] {
  const qs = quarters(periods)
  const out = new Map<string, SignalReading>()
  for (const q of qs.values()) {
    const base = [...qs.values()].find(yearBefore(q.end))
    if (!base || base.val <= 0) continue
    out.set(q.end, {
      date: q.end,
      value: round(q.val / base.val - 1),
      detail: {
        start: q.start,
        value: q.val,
        derived: q.less !== null,
        less: q.less && { start: q.less.start, end: q.less.end, value: q.less.val },
        unaudited: q.from.unaudited || (q.less?.unaudited ?? false),
        form: q.from.form,
        filed: q.from.filed,
        filing_url: q.from.filing_url,
        base_start: base.start,
        base_date: base.end,
        base_value: base.val,
        base_derived: base.less !== null,
        compare: null,
      },
      source_url: q.from.source_url,
      fetched_at: q.from.fetched_at,
    })
  }

  // The longest same-length pair at each end left over, read but not counted.
  const longest = new Map<string, { p: Period; base: Period }>()
  for (const p of periods) {
    if (out.has(p.end)) continue
    const base = periods.find((b) => Math.abs(b.days - p.days) <= 7 && yearBefore(p.end)(b))
    if (!base || base.val <= 0) continue
    const held = longest.get(p.end)
    if (!held || held.p.days < p.days) longest.set(p.end, { p, base })
  }
  for (const { p, base } of longest.values()) {
    out.set(p.end, {
      date: p.end,
      value: round(p.val / base.val - 1),
      detail: {
        start: p.start,
        value: p.val,
        unaudited: p.unaudited,
        form: p.form,
        filed: p.filed,
        filing_url: p.filing_url,
        base_start: base.start,
        base_date: base.end,
        base_value: base.val,
        compare: null,
        void_reason: `The ${p.days}-day period to ${p.end} isn’t a quarter and can’t be made one from the filings, so it isn’t compared with the quarterly readings.`,
      },
      source_url: p.source_url,
      fetched_at: p.fetched_at,
    })
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

export async function secRevenueGrowth(
  db: PipelineDb,
  company: LabId,
  deps: SignalDeps,
): Promise<SignalReading[]> {
  const revenue = await queryRevenue(db, queryContext(deps.sourcesYaml, null, deps.now))
  const own = revenue.providers.find((p) => p.provider === company)
  // A parent's figure (a segment, or the whole parent) is not the lab's revenue.
  if (!own || own.filer?.relation !== 'issuer') return []
  return revenueGrowth(own.periods)
}
