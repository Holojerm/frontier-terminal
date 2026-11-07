import { describe, expect, it } from 'vitest'

import type { ClaimDef, MeasuredRule } from '../shared/utils/thesis-types'

import { ANTHROPIC_THESIS } from '../server/theses/anthropic'
import {
  evaluateClaim,
  MAX_READING_AGE_DAYS,
  maxReadingAgeDays,
  sinceLabSetChange,
  staleGuard,
  weeklyCheckpoints,
  type StoredReading,
} from '../server/theses/status'
import { daysBefore } from '../server/utils/terminal-rankings'

// The kill-condition rules on typed readings: weekly checkpoints, the half-way
// "weakening" band, and the history a rule needs before it will say anything.

const fmt = (v: number) => v.toFixed(2)

const claim = (rule: MeasuredRule): ClaimDef => ({
  id: 'c',
  n: 1,
  text: 'claim',
  signal_label: 'signal',
  kill_condition: 'kill',
  spec: { kind: 'measured', signal: 'openrouter-spend-premium', rule },
})

/** One reading a day, newest on `end`, values oldest first. */
const daily = (end: string, values: number[], compare: number | null = null): StoredReading[] =>
  values.map((value, i) => ({ date: daysBefore(end, values.length - 1 - i), value, compare }))

/** One reading a week, newest on `end`, values oldest first. */
const weekly = (end: string, values: number[], compare: number | null = null): StoredReading[] =>
  values.map((value, i) => ({ date: daysBefore(end, 7 * (values.length - 1 - i)), value, compare }))

describe('weekly checkpoints', () => {
  it('steps back seven days at a time from the newest reading', () => {
    const cps = weeklyCheckpoints(daily('2026-10-08', Array(30).fill(1)), 4)
    expect(cps.map((r) => r.date)).toEqual(['2026-10-08', '2026-10-01', '2026-09-24', '2026-09-17'])
  })

  it('takes the nearest earlier reading within three days, and stops at a gap', () => {
    const readings: StoredReading[] = [
      { date: '2026-09-20', value: 1, compare: null },
      { date: '2026-09-29', value: 1, compare: null },
      { date: '2026-10-08', value: 1, compare: null },
    ]
    expect(weeklyCheckpoints(readings, 4).map((r) => r.date)).toEqual(['2026-10-08', '2026-09-29'])
  })
})

describe('sustained floor', () => {
  const rule = { rule: 'sustained-floor', floor: 1.3, comparator: 'openai', weeks: 4 } as const

  it('holds above the floor and the comparator', () => {
    const e = evaluateClaim(claim(rule), weekly('2026-10-08', [1.85], 0.9), fmt, 'OpenAI')
    expect(e.status).toBe('holding')
    expect(e.reason).toBe("1.85 against a floor of 1.30 and OpenAI's 0.90.")
  })

  it('weakens below the floor until the run is four weeks long, then breaks', () => {
    const three = evaluateClaim(claim(rule), weekly('2026-10-08', [1.5, 1.2, 1.2, 1.2]), fmt)
    expect(three.status).toBe('weakening')
    expect(three.reason).toContain('below at 3 of 4')
    const four = evaluateClaim(claim(rule), weekly('2026-10-08', [1.2, 1.2, 1.2, 1.2]), fmt)
    expect(four.status).toBe('broken')
  })

  it('says when the comparator could not be compared, instead of reading as a pass', () => {
    const [r] = weekly('2026-10-08', [1.85])
    const e = evaluateClaim(
      claim(rule),
      [{ ...r!, compare_unavailable: 'OpenAI had no priced tokens in the window.' }],
      fmt,
      'OpenAI',
    )
    expect(e.status).toBe('holding')
    expect(e.reason).toBe(
      '1.85 against a floor of 1.30. OpenAI had no priced tokens in the window.',
    )
  })

  it('counts falling under the comparator as a breach even above the floor', () => {
    const e = evaluateClaim(claim(rule), weekly('2026-10-08', [1.5], 1.6), fmt, 'OpenAI')
    expect(e.status).toBe('weakening')
  })

  it('is unresolved with no reading', () => {
    expect(evaluateClaim(claim(rule), [], fmt).status).toBe('unresolved')
  })
})

describe('below trailing average', () => {
  const rule = { rule: 'below-trailing-average', margin: 0.05, weeks: 13, min_weeks: 4 } as const

  it('is unresolved until min_weeks of prior checkpoints exist', () => {
    const e = evaluateClaim(claim(rule), weekly('2026-10-08', [0.2, 0.2, 0.2, 0.24]), fmt)
    expect(e.status).toBe('unresolved')
    expect(e.reason).toContain('3 of 13 weeks of history, needs 4')
  })

  it('holds near the average, weakens past half the margin, breaks past the margin', () => {
    const at = (now: number) =>
      evaluateClaim(claim(rule), weekly('2026-10-08', [0.3, 0.3, 0.3, 0.3, now]), fmt).status
    expect(at(0.29)).toBe('holding')
    expect(at(0.27)).toBe('weakening')
    expect(at(0.24)).toBe('broken')
  })

  it('reads a relative margin as a fraction of the average, so a smaller share keeps the bar', () => {
    const relative = { ...rule, margin: 0.2, relative: true }
    const at = (avg: number, now: number) =>
      evaluateClaim(claim(relative), weekly('2026-10-08', [avg, avg, avg, avg, now]), fmt).status
    // 20% of 0.25 is 5 points; 20% of 0.10 is 2 points.
    expect(at(0.25, 0.21)).toBe('weakening')
    expect(at(0.25, 0.19)).toBe('broken')
    expect(at(0.1, 0.095)).toBe('holding')
    expect(at(0.1, 0.085)).toBe('weakening')
    expect(at(0.1, 0.079)).toBe('broken')
  })
})

describe('drawdown from high', () => {
  const rule = { rule: 'drawdown-from-high', drop: 0.25, days: 90, min_days: 30 } as const

  it('is unresolved with under min_days of history', () => {
    expect(evaluateClaim(claim(rule), daily('2026-10-08', Array(20).fill(100)), fmt).status).toBe(
      'unresolved',
    )
  })

  it('measures the fall from the high inside the window', () => {
    const at = (now: number) =>
      evaluateClaim(claim(rule), daily('2026-10-08', [...Array(40).fill(100), now]), fmt).status
    expect(at(95)).toBe('holding')
    expect(at(85)).toBe('weakening')
    expect(at(75)).toBe('broken')
  })

  it('forgets a high older than the window', () => {
    const readings = [...daily('2026-06-01', [500]), ...daily('2026-10-08', Array(60).fill(100))]
    expect(evaluateClaim(claim(rule), readings, fmt).status).toBe('holding')
  })
})

describe('below floor periods', () => {
  const rule = { rule: 'below-floor-periods', floor: 0.25, periods: 2 } as const
  const q = (date: string, value: number): StoredReading => ({ date, value, compare: null })

  it('breaks on two straight quarters below the floor', () => {
    const e = evaluateClaim(
      claim(rule),
      [q('2026-03-31', 0.4), q('2026-06-30', 0.2), q('2026-09-30', 0.1)],
      fmt,
    )
    expect(e.status).toBe('broken')
    expect(e.reason).toContain('below for 2 of 2 straight periods')
  })

  it('does not join two below-floor quarters across a quarter never read', () => {
    // Q2 is missing: Q1 and Q3 are not "2 straight quarters".
    const e = evaluateClaim(
      claim(rule),
      [q('2025-12-31', 0.4), q('2026-03-31', 0.2), q('2026-09-30', 0.1)],
      fmt,
    )
    expect(e.status).toBe('weakening')
    expect(e.reason).toContain('below for 1 of 2 straight periods')
  })

  it('reads months by their own cadence', () => {
    const three = { rule: 'below-floor-periods', floor: 1, periods: 3 } as const
    const m = (date: string) => q(date, 0.9)
    const straight = [m('2026-06-01'), m('2026-07-01'), m('2026-08-01'), m('2026-09-01')]
    expect(evaluateClaim(claim(three), straight, fmt).status).toBe('broken')
    const gap = [m('2026-05-01'), m('2026-06-01'), m('2026-08-01'), m('2026-09-01')]
    expect(evaluateClaim(claim(three), gap, fmt).status).toBe('weakening')
  })
})

describe('stale readings', () => {
  const rule = { rule: 'sustained-floor', floor: 1.3, comparator: null, weeks: 4 } as const
  const readings = weekly('2026-10-08', [1.2, 1.2, 1.2, 1.2])
  const broken = evaluateClaim(claim(rule), readings, fmt)

  it('keeps the status while the newest reading is fresh', () => {
    expect(broken.status).toBe('broken')
    expect(staleGuard(claim(rule), readings, broken, '2026-10-15T12:00:00Z')).toBe(broken)
  })

  it('reads unresolved, naming the reading’s age, once a daily signal stops reading', () => {
    const stale = staleGuard(claim(rule), readings, broken, '2026-10-20T00:00:00Z')
    expect(stale).toEqual({
      status: 'unresolved',
      reason:
        'Stale: the newest reading is from 2026-10-08, 12 days ago, and this signal reads at least every 7 days. It read broken then.',
      reading_date: '2026-10-08',
    })
  })

  it('allows each signal its own cadence', () => {
    const ramp = ANTHROPIC_THESIS.claims.find((c) => c.id === 'anthropic-enterprise-lead')!
    const revenue = ANTHROPIC_THESIS.claims.find((c) => c.id === 'anthropic-revenue-growth')!
    expect(maxReadingAgeDays(ramp)).toBe(MAX_READING_AGE_DAYS.monthly)
    expect(maxReadingAgeDays(revenue)).toBe(MAX_READING_AGE_DAYS.quarterly)
    expect(maxReadingAgeDays(claim(rule))).toBe(MAX_READING_AGE_DAYS.daily)
    expect(
      maxReadingAgeDays(ANTHROPIC_THESIS.claims.find((c) => c.spec.kind === 'judged')!),
    ).toBeNull()
  })
})

describe('the Anthropic thesis', () => {
  it('leaves judged claims unresolved until the judge rates them', () => {
    const judged = ANTHROPIC_THESIS.claims.filter((c) => c.spec.kind === 'judged')
    expect(judged.map((c) => c.n)).toEqual([3, 5])
    for (const c of judged) expect(evaluateClaim(c, [], fmt).status).toBe('unresolved')
  })

  it('keeps claim ids unique — readings and status changes are keyed by them', () => {
    const ids = ANTHROPIC_THESIS.claims.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('a lab entering or leaving a median', () => {
  const at = (date: string, lab_set: string | null) => ({ date, lab_set })

  it('restarts the series at the newest lab-set change', () => {
    const series = [
      at('2026-10-01', 'anthropic,google,openai'),
      at('2026-10-08', 'anthropic,google,openai'),
      at('2026-10-15', 'anthropic,openai'),
      at('2026-10-22', 'anthropic,openai'),
    ]
    expect(sinceLabSetChange(series).map((r) => r.date)).toEqual(['2026-10-15', '2026-10-22'])
  })

  it('keeps readings stored before the lab set was recorded', () => {
    const series = [at('2026-10-01', null), at('2026-10-08', 'anthropic,openai')]
    expect(sinceLabSetChange(series)).toHaveLength(2)
  })
})
