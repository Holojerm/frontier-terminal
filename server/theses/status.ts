// A claim's status from its stored readings — pure, no clock, no database, so
// the evaluator (writes status changes) and GET /api/theses (shows them) cannot
// disagree, and test/theses-status.test.ts drives every rule on typed rows.
//
// Every rule reads weekly checkpoints rather than every daily reading: a
// kill condition says "for 4 straight weeks", and seven overlapping trailing
// windows a week are one observation, not seven. "Weakening" is half way to
// the kill condition (half the run, half the margin, half the drop), so it
// warns before it breaks without needing a threshold of its own.

import type { ClaimDef, ClaimStatus, MeasuredRule } from '#shared/utils/thesis-types'

import { daysBefore } from '../utils/terminal-rankings'

export interface StoredReading {
  date: string
  value: number
  /** The comparator's value on the same date, where the rule has one. */
  compare: number | null
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
  if (run === 0) return { status: 'holding', reason: `${vs}.`, reading_date: now.date }
  const status: ClaimStatus = run >= rule.weeks ? 'broken' : 'weakening'
  return {
    status,
    reason: `${vs}: below at ${run} of ${rule.weeks} straight weekly checkpoints.`,
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
  const status: ClaimStatus =
    gap > rule.margin ? 'broken' : gap > rule.margin / 2 ? 'weakening' : 'holding'
  return {
    status,
    reason: `${fmt(now.value)} against a trailing average of ${fmt(avg)} (kill below ${fmt(avg - rule.margin)}); ${history}.`,
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

function belowFloorPeriods(
  rule: Extract<MeasuredRule, { rule: 'below-floor-periods' }>,
  readings: readonly StoredReading[],
  fmt: Formatter,
): ClaimEvaluation {
  const desc = [...readings].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const now = desc[0]
  if (!now) return unresolved('No reading yet.')
  let run = 0
  while (run < Math.min(desc.length, rule.periods) && desc[run]!.value < rule.floor) run++
  const vs = `${fmt(now.value)} for the period ending ${now.date}, against a floor of ${fmt(rule.floor)}`
  if (run === 0) return { status: 'holding', reason: `${vs}.`, reading_date: now.date }
  return {
    status: run >= rule.periods ? 'broken' : 'weakening',
    reason: `${vs}: below for ${run} of ${rule.periods} straight periods.`,
    reading_date: now.date,
  }
}

/** The claim's status from its readings, oldest-to-newest order not required. */
export function evaluateClaim(
  claim: ClaimDef,
  readings: readonly StoredReading[],
  fmt: Formatter,
  comparatorName: string | null = null,
): ClaimEvaluation {
  const spec = claim.spec
  if (spec.kind === 'judged') return unresolved('Judged signal: rated from M2 on.')
  switch (spec.rule.rule) {
    case 'sustained-floor':
      return sustainedFloor(spec.rule, readings, fmt, comparatorName)
    case 'below-trailing-average':
      return belowTrailingAverage(spec.rule, readings, fmt)
    case 'drawdown-from-high':
      return drawdownFromHigh(spec.rule, readings, fmt)
    case 'below-floor-periods':
      return belowFloorPeriods(spec.rule, readings, fmt)
  }
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
        : 7 * r.weeks
  return days + 7 + CHECKPOINT_SLACK_DAYS
}
