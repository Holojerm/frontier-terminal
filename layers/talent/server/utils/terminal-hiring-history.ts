// Open roles per day, derived from the history the store already holds, as
// pure functions over rows. terminal-hiring.ts and the hiring floor fetch the
// rows; nothing here touches D1, so layers/terminal/test/terminal-history.test.ts
// drives every rule with a handful of fixture rows.
//
// The store keeps the CURRENT entity set plus an append-only change log
// (server/db/schema.ts), so every past state is the current state with the
// changes after that instant undone. No clock is read: `now` is an argument.

import type {
  DeptCompare,
  DeptSeries,
  HiringCompare,
} from '../../shared/utils/terminal-types/hiring'

import type * as tables from '#server/db/schema'
import { byString, parseJson, str } from '../../../core/server/utils/terminal-json'
import { byDetectedAt } from '../../../core/server/utils/terminal-db'

type Change = typeof tables.changes.$inferSelect

const at = (iso: string) => Date.parse(iso)

// ---- hiring ----------------------------------------------------------------

export interface OpenRole {
  entity_key: string
  provider: string
  department: string
}

export const NO_DEPARTMENT = '(no department)'

const deptOf = (payload: Record<string, unknown> | null): string =>
  str(payload?.department) ?? NO_DEPARTMENT

/** Counts per provider, per department, at one instant. */
export type OpenCounts = Map<string, Map<string, number>>

/**
 * Open roles per provider and department at each of `instants` (any order),
 * by walking the change log backwards from `current`. Undoing an `added`
 * closes the role, undoing a `removed` reopens it in its last department,
 * undoing a `modified` restores its previous department. A change that
 * cannot be undone against the set — an added role the current set no
 * longer holds, because it closed between the last imported poll and this
 * store's baseline — is skipped rather than pushed below zero.
 */
export function openRolesAt(
  current: readonly OpenRole[],
  changes: readonly Change[],
  instants: readonly string[],
): Map<string, OpenCounts> {
  const state = new Map<string, { provider: string; department: string }>()
  const counts: OpenCounts = new Map()
  const bump = (provider: string, department: string, by: number) => {
    const depts = counts.get(provider) ?? new Map<string, number>()
    depts.set(department, (depts.get(department) ?? 0) + by)
    counts.set(provider, depts)
  }
  for (const role of current) {
    state.set(role.entity_key, { provider: role.provider, department: role.department })
    bump(role.provider, role.department, 1)
  }

  const log = [...changes].sort(byDetectedAt).reverse()
  const order = [...instants].sort((a, b) => at(b) - at(a))
  const out = new Map<string, OpenCounts>()
  let i = 0
  for (const instant of order) {
    const t = at(instant)
    while (i < log.length && at(log[i]!.detected_at) > t) {
      const c = log[i++]!
      const held = state.get(c.entity_key)
      if (c.change_type === 'added') {
        if (!held) continue
        state.delete(c.entity_key)
        bump(held.provider, held.department, -1)
      } else if (c.change_type === 'removed') {
        if (held) continue
        const department = deptOf(parseJson(c.before_json))
        state.set(c.entity_key, { provider: c.provider, department })
        bump(c.provider, department, 1)
      } else if (held) {
        const department = deptOf(parseJson(c.before_json))
        if (department === held.department) continue
        bump(held.provider, held.department, -1)
        held.department = department
        bump(held.provider, department, 1)
      }
    }
    const copy: OpenCounts = new Map()
    for (const [provider, depts] of counts) copy.set(provider, new Map(depts))
    out.set(instant, copy)
  }
  return out
}

/** YYYY-MM-DD of an instant, in UTC. */
export const dayOf = (iso: string): string => iso.slice(0, 10)

const DAY = 86_400_000

/**
 * The instants a daily series is read at: the end of every UTC day from
 * `from` to `now`, with today's point read at `now` itself so the newest
 * value equals the current set exactly.
 */
export function dailyInstants(from: string, now: string): { date: string; at: string }[] {
  const out: { date: string; at: string }[] = []
  const end = at(now)
  for (
    let day = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
    ;
    day += DAY
  ) {
    const next = day + DAY
    const date = new Date(day).toISOString().slice(0, 10)
    if (next > end) {
      out.push({ date, at: now })
      break
    }
    out.push({ date, at: new Date(next - 1).toISOString() })
  }
  return out
}

/** Department rows for one provider across the daily points, largest today first. */
export function departmentSeries(
  byInstant: ReadonlyMap<string, OpenCounts>,
  instants: readonly { at: string }[],
  provider: string,
): { total: number[]; departments: DeptSeries[] } {
  const names = new Set<string>()
  for (const { at: t } of instants) {
    for (const name of byInstant.get(t)?.get(provider)?.keys() ?? []) names.add(name)
  }
  const departments: DeptSeries[] = [...names]
    .map((department) => ({
      department,
      series: instants.map((p) => byInstant.get(p.at)?.get(provider)?.get(department) ?? 0),
    }))
    .filter((d) => d.series.some((n) => n > 0))
    .sort((a, b) => b.series.at(-1)! - a.series.at(-1)! || byString(a.department, b.department))
  const total = instants.map((_, i) => departments.reduce((n, d) => n + d.series[i]!, 0))
  return { total, departments }
}

/**
 * Now against the point `windowDays` back, or the first point when the
 * series is younger than that — `days` reports the real gap either way.
 */
export function compareWindow(
  dates: readonly string[],
  total: readonly number[],
  departments: readonly DeptSeries[],
  windowDays: number,
): HiringCompare | null {
  if (dates.length < 2) return null
  const last = dates.length - 1
  const target = at(dates[last]!) - windowDays * DAY
  let i = 0
  while (i < last && at(dates[i]!) < target) i++
  if (i === last) i = last - 1
  const rows: DeptCompare[] = departments
    .map((d) => ({ department: d.department, then: d.series[i]!, now: d.series[last]! }))
    .filter((d) => d.then > 0 || d.now > 0)
    .sort((a, b) => b.now - a.now || byString(a.department, b.department))
  return {
    at: dates[i]!,
    days: Math.round((at(dates[last]!) - at(dates[i]!)) / DAY),
    total_then: total[i]!,
    total_now: total[last]!,
    departments: rows,
  }
}
