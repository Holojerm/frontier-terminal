import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { labName } from '../../shared/utils/terminal-labs'
import type { DepartmentCluster } from '../utils/terminal-clusters'
import { AlertRow, ChangeRow, contentHash } from './contracts'
import { boardMoves, describeReason, signed, type BoardMove } from './hiring-floor'
import { insertRows, unstoredAlerts, type PipelineDb } from './store'

// The hiring roll-up: one alert per lab per week saying what its board did
// — net change, and the departments that moved most — citing every role
// added or closed that week. No model in the loop.
//
// The judge sees one poll's batch at a time, so a week of +2s never reaches
// the alert tier on its own; the roll-up is where it adds up. It is
// `notable` only when the week's moves clear the hiring materiality floor
// (hiring-floor.ts), `info` otherwise, and never `critical`: social.ts posts
// critical alerts only, so a roll-up is never posted on its own.
//
// Run once a week (alerts:hiring-rollup, Monday 13:00 UTC) over the last
// complete ISO week. The id hashes (lab, week), so a re-run writes nothing,
// and only that one week is ever rolled up: no back-fill of past weeks.

export const HIRING_ROLLUP_RULE = 'hiring-rollup' as const

/** Departments named in the headline. */
const HEADLINE_DEPARTMENTS = 3
/** Departments named in the explanation. */
const EXPLANATION_DEPARTMENTS = 6

const DAY_MS = 86_400_000

/** The Monday-to-Monday UTC week before the one `now` falls in. */
export function lastCompleteWeek(now: Date): { start: string; end: string } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const sinceMonday = (now.getUTCDay() + 6) % 7
  const end = midnight - sinceMonday * DAY_MS
  return {
    start: new Date(end - 7 * DAY_MS).toISOString(),
    end: new Date(end).toISOString(),
  }
}

const roles = (n: number) => `${n} role${n === 1 ? '' : 's'}`

/** One lab's roll-up alert, from its week of changes and their score. */
export function composeRollup(
  week: { start: string; end: string },
  move: BoardMove,
  changes: readonly ChangeRow[],
): AlertRow {
  const lab = labName(move.provider)
  const from = week.start.slice(0, 10)
  const to = new Date(Date.parse(week.end) - DAY_MS).toISOString().slice(0, 10)
  const moved = move.departments.filter((d) => d.net !== 0)
  const top = moved
    .slice(0, HEADLINE_DEPARTMENTS)
    .map((d) => `${d.department} ${signed(d.net)}`)
    .join(', ')

  const headline =
    `${lab} hiring, week of ${from}: net ${signed(move.net)} ` +
    `(${move.added} added, ${move.removed} closed)` +
    (top ? `; ${top}` : '')

  const departments = moved
    .slice(0, EXPLANATION_DEPARTMENTS)
    .map((d) => `${d.department} ${signed(d.net)} (${d.before} to ${d.now})`)
    .join('; ')
  const material = move.material.map(describeReason).join('; ')
  const explanation = [
    `From ${from} to ${to} the ${lab} job board added ${roles(move.added)} and closed ` +
      `${roles(move.removed)}: net ${signed(move.net)}, from ${move.before} open roles to ${move.now}.`,
    departments ? `Departments that moved most: ${departments}.` : '',
    material
      ? `Above the hiring materiality floor: ${material}.`
      : 'Below the hiring materiality floor, so a ticker line: no department, cluster or board-wide move was large for its size.',
    'Rule-based: one hiring roll-up per lab per week, no model in the loop. It cites every role added or closed that week.',
  ]
    .filter(Boolean)
    .join(' ')

  // Provenance is the newest cited change, ties broken by the smallest id,
  // as the judge's alerts are stamped (judge/contract.ts).
  const ids = changes.map((c) => c.id).sort()
  let newest = changes[0]!
  for (const c of changes.slice(1)) {
    const later = Date.parse(c.detected_at) - Date.parse(newest.detected_at)
    if (later > 0 || (later === 0 && c.id < newest.id)) newest = c
  }

  return AlertRow.parse({
    id: contentHash({ rule: HIRING_ROLLUP_RULE, provider: move.provider, week: week.start }),
    severity: move.material.length ? 'notable' : 'info',
    headline,
    explanation,
    change_ids: JSON.stringify(ids),
    rule: HIRING_ROLLUP_RULE,
    created_at: newest.detected_at,
    source_url: newest.source_url,
    fetched_at: newest.fetched_at,
  })
}

/** The roll-ups for the last complete week before `now`, one per lab with roles added or closed. */
export async function hiringRollupAlerts(
  db: PipelineDb,
  clusters: readonly DepartmentCluster[],
  now: Date,
): Promise<AlertRow[]> {
  const week = lastCompleteWeek(now)
  const rows = await db
    .select()
    .from(tables.changes)
    .where(
      and(
        eq(tables.changes.entity_type, 'job'),
        inArray(tables.changes.change_type, ['added', 'removed']),
        gte(tables.changes.detected_at, week.start),
        lt(tables.changes.detected_at, week.end),
      ),
    )
    .orderBy(asc(tables.changes.detected_at), asc(tables.changes.id))
  const changes = rows.map((row) => ChangeRow.parse(row))
  const moves = await boardMoves(db, changes, clusters)
  return moves.map((move) =>
    composeRollup(
      week,
      move,
      changes.filter((c) => c.provider === move.provider),
    ),
  )
}

/** Write the last complete week's roll-ups that are not stored yet. Returns how many were new. */
export async function writeHiringRollups(
  db: PipelineDb,
  clusters: readonly DepartmentCluster[],
  now = new Date(),
): Promise<{ week: string; inserted: number; notable: number }> {
  const alerts = await unstoredAlerts(db, await hiringRollupAlerts(db, clusters, now))
  const inserted = await insertRows(db, 'alerts', alerts)
  return {
    week: lastCompleteWeek(now).start.slice(0, 10),
    inserted,
    notable: alerts.filter((a) => a.severity === 'notable').length,
  }
}
