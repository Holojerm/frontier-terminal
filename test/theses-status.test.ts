import { describe, expect, it } from 'vitest'

import type { ClaimDef, MeasuredRule } from '#shared/utils/thesis-types'

import { ANTHROPIC_THESIS } from '../server/theses/anthropic'
import { evaluateClaim, weeklyCheckpoints, type StoredReading } from '../server/theses/status'
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
