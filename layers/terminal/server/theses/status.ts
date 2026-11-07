// A claim's status from its stored readings — pure, no clock, no database, so
// the evaluator (writes status changes) and GET /api/theses (shows them) cannot
// disagree, and layers/terminal/test/theses-status.test.ts drives every rule on typed rows.
//
// Every rule reads weekly checkpoints rather than every daily reading: a
// kill condition says "for 4 straight weeks", and seven overlapping trailing
// windows a week are one observation, not seven. "Weakening" is the first
// step toward the kill condition: a run rule (N straight weeks or periods)
// weakens at the first breached checkpoint, a margin or drop rule at half the
// margin or half the drop. It warns before it breaks without needing a
// threshold of its own.

import type { ClaimDef, ClaimStatus, MeasuredRule } from '../../shared/utils/thesis-types'

import { daysBefore } from '../utils/terminal-rankings'

export interface StoredReading {
  date: string
  value: number
  /** The comparator's value on the same date, where the rule has one. */
  compare: number | null
  /** Set when the signal could compute a number but not one the rule may read
   * (too few providers behind a median). The newest such reading leaves the
   * claim unresolved; older ones are skipped. */
  void_reason?: string | null
  /** Set when the comparator had no value on this date, so only the floor was tested. */
  compare_unavailable?: string | null
  /** The labs behind a median reading, comma-joined; null for other signals or older rows. */
  lab_set?: string | null
}

/**
 * A median over labs steps when a lab enters or leaves the set, and that step
 * is the registry's, not the market's. So a rule compares only readings taken
 * over the newest reading's lab set: the series restarts at the last change.
 * Readings stored before lab_set was recorded carry none and are kept. The
 * page still charts the whole series; only the rule reads from the restart.
 */
export function sinceLabSetChange<T extends { lab_set?: string | null }>(
  readings: readonly T[],
): T[] {
  const newest = readings.at(-1)?.lab_set
  if (!newest) return [...readings]
  let start = readings.length - 1
  while (start > 0) {
    const prior = readings[start - 1]!.lab_set ?? null
    if (prior !== null && prior !== newest) break
    start--
  }
  return readings.slice(start)
}

export interface ClaimEvaluation {
  status: ClaimStatus
  reason: string
  reading_date: string | null
}

/** A checkpoint may sit up to this many days before its target date: the
 * rankings feed lags, and a missed tick should not break a run. */
const CHECKPOINT_SLACK_DAYS = 3

const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000)

/** Newest first: the newest reading, then the reading nearest at or before
 * each 7-day step back. Stops at the first step with no reading in reach. */
export function weeklyCheckpoints(
  readings: readonly StoredReading[],
  count: number,
): StoredReading[] {
  const asc = [...readings].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const newest = asc.at(-1)
  if (!newest) return []
  const out = [newest]
  for (let k = 1; k < count; k++) {
    const target = daysBefore(newest.date, 7 * k)
    const hit = asc.findLast((r) => r.date <= target)
    if (!hit || dayDiff(target, hit.date) > CHECKPOINT_SLACK_DAYS) break
    out.push(hit)
  }
  return out
}

export type Formatter = (value: number) => string

const unresolved = (reason: string, reading_date: string | null = null): ClaimEvaluation => ({
  status: 'unresolved',
  reason,
  reading_date,
})

function sustainedFloor(
  rule: Extract<MeasuredRule, { rule: 'sustained-floor' }>,
  readings: readonly StoredReading[],
  fmt: Formatter,
  comparatorName: string | null,
): ClaimEvaluation {
  const cps = weeklyCheckpoints(readings, rule.weeks)
  const now = cps[0]
  if (!now) return unresolved('No reading yet.')
  const breach = (r: StoredReading) =>
    r.value < rule.floor || (r.compare !== null && r.value < r.compare)
  let run = 0
  while (run < cps.length && breach(cps[run]!)) run++
  const vs = `${fmt(now.value)} against a floor of ${fmt(rule.floor)}${
    comparatorName && now.compare !== null ? ` and ${comparatorName}'s ${fmt(now.compare)}` : ''
  }`
  // Without the comparator only the floor was tested; the reason says so
  // rather than reading as if both tests passed.
  const note = now.compare_unavailable ? ` ${now.compare_unavailable}` : ''
  if (run === 0) return { status: 'holding', reason: `${vs}.${note}`, reading_date: now.date }
  const status: ClaimStatus = run >= rule.weeks ? 'broken' : 'weakening'
  return {
    status,
    reason: `${vs}: below at ${run} of ${rule.weeks} straight weekly checkpoints.${note}`,
    reading_date: now.date,
  }
}

function belowTrailingAverage(
  rule: Extract<MeasuredRule, { rule: 'below-trailing-average' }>,
  readings: readonly StoredReading[],
  fmt: Formatter,
): ClaimEvaluation {
  const cps = weeklyCheckpoints(readings, rule.weeks + 1)
  const now = cps[0]
  if (!now) return unresolved('No reading yet.')
  const prior = cps.slice(1)
  const history = `${prior.length} of ${rule.weeks} weeks of history`
  if (prior.length < rule.min_weeks) {
    return unresolved(`${fmt(now.value)}; ${history}, needs ${rule.min_weeks}.`, now.date)
  }
  const avg = prior.reduce((n, r) => n + r.value, 0) / prior.length
  const gap = avg - now.value
  const margin = rule.relative ? avg * rule.margin : rule.margin
  const status: ClaimStatus = gap > margin ? 'broken' : gap > margin / 2 ? 'weakening' : 'holding'
  return {
    status,
    reason: `${fmt(now.value)} against a trailing average of ${fmt(avg)} (kill below ${fmt(avg - margin)}); ${history}.`,
    reading_date: now.date,
  }
}

function drawdownFromHigh(
  rule: Extract<MeasuredRule, { rule: 'drawdown-from-high' }>,
  readings: readonly StoredReading[],
  fmt: Formatter,
): ClaimEvaluation {
  const asc = [...readings].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const now = asc.at(-1)
  if (!now) return unresolved('No reading yet.')
  const span = Math.min(dayDiff(now.date, asc[0]!.date), rule.days)
  const history = `${span} of ${rule.days} days of history`
  if (span < rule.min_days) {
    return unresolved(`${fmt(now.value)}; ${history}, needs ${rule.min_days}.`, now.date)
  }
  const from = daysBefore(now.date, rule.days)
  const high = asc.filter((r) => r.date >= from).reduce((h, r) => (r.value >= h.value ? r : h))
  const drop = high.value > 0 ? 1 - now.value / high.value : 0
  const status: ClaimStatus =
    drop >= rule.drop ? 'broken' : drop >= rule.drop / 2 ? 'weakening' : 'holding'
  const pct = Math.round(drop * 100)
  return {
    status,
    reason: `${fmt(now.value)}, ${pct}% below the high of ${fmt(high.value)} on ${high.date} (kill at ${fmt(high.value * (1 - rule.drop))}); ${history}.`,
    reading_date: now.date,
  }
}

/**
 * A run of periods breaks at a gap this many times the series' cadence: a
 * month or quarter that was never read. Calendar months and quarters vary by
 * a few days, so anything short of half a period more is the next period.
 */
const PERIOD_GAP_FACTOR = 1.5

/** The series' period, in days: the shortest gap between adjacent readings. */
function cadenceDays(desc: readonly StoredReading[]): number | null {
  let shortest: number | null = null
  for (let i = 1; i < desc.length; i++) {
    const gap = dayDiff(desc[i - 1]!.date, desc[i]!.date)
    if (gap > 0 && (shortest === null || gap < shortest)) shortest = gap
  }
  return shortest
}

function belowFloorPeriods(
  rule: Extract<MeasuredRule, { rule: 'below-floor-periods' }>,
  readings: readonly StoredReading[],
  fmt: Formatter,
): ClaimEvaluation {
  const desc = [...readings].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const now = desc[0]
  if (!now) return unresolved('No reading yet.')
  // "Straight" periods: a skipped period between two readings ends the run,
  // or two quarters a year apart would read as two in a row.
  const cadence = cadenceDays(desc)
  const adjacent = (i: number) =>
    i === 0 ||
    cadence === null ||
    dayDiff(desc[i - 1]!.date, desc[i]!.date) <= cadence * PERIOD_GAP_FACTOR
  let run = 0
  while (
    run < Math.min(desc.length, rule.periods) &&
    adjacent(run) &&
    desc[run]!.value < rule.floor
  ) {
    run++
  }
  const vs = `${fmt(now.value)} for the period ending ${now.date}, against a floor of ${fmt(rule.floor)}`
  if (run === 0) return { status: 'holding', reason: `${vs}.`, reading_date: now.date }
  return {
    status: run >= rule.periods ? 'broken' : 'weakening',
    reason: `${vs}: below for ${run} of ${rule.periods} straight periods.`,
    reading_date: now.date,
  }
}

function sustainedDrawdown(
  rule: Extract<MeasuredRule, { rule: 'sustained-drawdown' }>,
  readings: readonly StoredReading[],
  fmt: Formatter,
): ClaimEvaluation {
  const asc = [...readings].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const now = asc.at(-1)
  if (!now) return unresolved('No reading yet.')
  const needDays = rule.days + 7 * (rule.weeks - 1)
  const span = dayDiff(now.date, asc[0]!.date)
  const history = `${Math.min(span, needDays)} of ${needDays} days of history`
  const highBefore = (r: StoredReading) => {
    const from = daysBefore(r.date, rule.days)
    return asc
      .filter((x) => x.date >= from && x.date <= r.date)
      .reduce((h, x) => (x.value >= h.value ? x : h))
  }
  const dropAt = (r: StoredReading) => {
    const high = highBefore(r)
    return high.value > 0 ? 1 - r.value / high.value : 0
  }
  const high = highBefore(now)
  const drop = dropAt(now)
  const where = `${fmt(now.value)}, ${Math.round(drop * 100)}% below the high of ${fmt(high.value)} on ${high.date} (kill at ${fmt(high.value * (1 - rule.drop))})`
  if (span < needDays) {
    return unresolved(`${where}; ${history}, needs ${needDays}.`, now.date)
  }
  const cps = weeklyCheckpoints(asc, rule.weeks)
  let run = 0
  while (run < cps.length && dropAt(cps[run]!) >= rule.drop) run++
  const status: ClaimStatus =
    run >= rule.weeks ? 'broken' : run > 0 || drop >= rule.drop / 2 ? 'weakening' : 'holding'
  return {
    status,
    reason: `${where}: at or past the kill line at ${run} of ${rule.weeks} straight weekly checkpoints; ${history}.`,
    reading_date: now.date,
  }
}

/** The claim's status from its readings, oldest-to-newest order not required. */
export function evaluateClaim(
  claim: ClaimDef,
  all: readonly StoredReading[],
  fmt: Formatter,
  comparatorName: string | null = null,
): ClaimEvaluation {
  const spec = claim.spec
  if (spec.kind === 'judged') return unresolved('Judged signal: rated from M2 on.')
  const newest = all.reduce<StoredReading | null>((n, r) => (!n || r.date > n.date ? r : n), null)
  if (newest?.void_reason) return unresolved(newest.void_reason, newest.date)
  const readings = all.filter((r) => !r.void_reason)
  switch (spec.rule.rule) {
    case 'sustained-floor':
      return sustainedFloor(spec.rule, readings, fmt, comparatorName)
    case 'below-trailing-average':
      return belowTrailingAverage(spec.rule, readings, fmt)
    case 'drawdown-from-high':
      return drawdownFromHigh(spec.rule, readings, fmt)
    case 'below-floor-periods':
      return belowFloorPeriods(spec.rule, readings, fmt)
    case 'sustained-drawdown':
      return sustainedDrawdown(spec.rule, readings, fmt)
  }
}

/**
 * How old a measured signal's newest reading may get before its claim stops
 * standing on it. Past this the signal has stopped producing readings — a
 * source moved, a recipe broke — and the last status would otherwise stand
 * forever. Each is the signal's normal gap between readings plus its source's
 * publication lag, with room for a missed week.
 */
export const MAX_READING_AGE_DAYS = {
  /** Polled daily (rankings, job boards, price pages, npm): a week is many missed polls. */
  daily: 7,
  /** Monthly, published about six weeks after the month it describes (Ramp AI Index). */
  monthly: 80,
  /** Quarterly from SEC filings: a quarter, plus a 10-K's up-to-90 days after year end. */
  quarterly: 190,
  /** Epoch's data-center snapshots arrive irregularly, every few weeks. */
  snapshot: 45,
} as const

/** Recipes read as period series, by cadence; any other defaults to quarterly, the slowest. */
const RECIPE_CADENCE: Readonly<Record<string, keyof typeof MAX_READING_AGE_DAYS>> = {
  'ramp-ai-index': 'monthly',
  'sec-revenue-net': 'quarterly',
  'sec-revenue-crwv': 'quarterly',
}

/** The newest reading age, in days, a measured claim accepts; null for a judged one. */
export function maxReadingAgeDays(claim: ClaimDef): number | null {
  const spec = claim.spec
  if (spec.kind !== 'measured') return null
  switch (spec.signal) {
    case 'sec-revenue-yoy-growth':
      return MAX_READING_AGE_DAYS.quarterly
    case 'recipe-yoy-growth':
    case 'recipe-key-ratio':
      return MAX_READING_AGE_DAYS[RECIPE_CADENCE[spec.recipe] ?? 'quarterly']
    case 'recipe-snapshot-total':
      return MAX_READING_AGE_DAYS.snapshot
    default:
      return MAX_READING_AGE_DAYS.daily
  }
}

/**
 * Unresolved, naming the reading's age, when the newest reading is older than
 * the claim's signal allows; otherwise `evaluation` as it stands. A stale
 * reading says nothing about now, in either direction.
 */
export function staleGuard(
  claim: ClaimDef,
  readings: readonly StoredReading[],
  evaluation: ClaimEvaluation,
  now: string,
): ClaimEvaluation {
  const max = maxReadingAgeDays(claim)
  const newest = readings.reduce<string | null>((n, r) => (!n || r.date > n ? r.date : n), null)
  if (max === null || newest === null) return evaluation
  const age = dayDiff(now.slice(0, 10), newest)
  if (age <= max) return evaluation
  return unresolved(
    `Stale: the newest reading is from ${newest}, ${age} days ago, and this signal reads at least every ${max} days. It read ${evaluation.status} then.`,
    newest,
  )
}

/** Days of readings a rule needs on hand to evaluate (plus slack). */
export function historyDays(claim: ClaimDef): number {
  const spec = claim.spec
  if (spec.kind === 'judged') return 0
  const r = spec.rule
  const days =
    r.rule === 'drawdown-from-high'
      ? r.days
      : r.rule === 'below-floor-periods'
        ? 92 * r.periods
        : r.rule === 'sustained-drawdown'
          ? r.days + 7 * r.weeks
          : 7 * r.weeks
  return days + 7 + CHECKPOINT_SLACK_DAYS
}
