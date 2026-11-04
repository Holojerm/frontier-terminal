import { and, eq, gt, inArray, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { inCluster, type DepartmentCluster } from '../utils/terminal-clusters'
import { NO_DEPARTMENT, openRolesAt, type OpenRole } from '../utils/terminal-history'
import type { ChangeRow } from './contracts'
import type { PipelineDb } from './store'

// The hiring materiality floor: when a set of job changes is worth the alert
// tier. A move counts relative to the board or department it happens on,
// never as a bare count, because the boards differ by 60x (Mistral ~13 open
// roles, OpenAI ~810) and a department of 4 is not a department of 150.
//
// The judge applies the same rubric (judge-explain.prompt.md), but the
// Worker enforces it: a judged hiring alert below the floor is clamped to
// `info` at submit (judge/submit.ts), whatever severity the routine sent.
// The weekly roll-up (hiring-rollup.ts) uses it to pick its severity.
//
// Thresholds, set against the judged history to 2026-11-04 (32 alert-tier
// hiring alerts; 22 of them fall below the floor — GTM churn of +2 on a
// 566-role board, "Marketing goes dark" on a 5-of-50 cut — and the 10 that
// clear it are the Human Data wind-down, the data-center and Compute moves,
// and a 5-of-19 Data Science pull):
//   board       |net| >= max(5, 2% of the board)        Anthropic ~680 -> 14
//   department  |net| >= 5 AND >= 20% of the department  25% would drop xAI's
//                                                        first Human Data cut (-5 of 23)
//   opened/closed a department going 0 -> 3+ or 3+ -> 0
//   cluster     |net| >= max(3, 5% of the cluster)       the buildout signal;
//                                                        xAI's ~150-role data-center
//                                                        cluster needs 8, Anthropic's ~25 needs 3
// `net` counts `added` minus `removed`. A `modified` that moves a role between
// departments is a relabel, not a hire or a closure, and never counts.

export const HIRING_FLOOR = {
  boardShare: 0.02,
  boardMin: 5,
  departmentShare: 0.2,
  departmentMin: 5,
  openCloseMin: 3,
  clusterShare: 0.05,
  clusterMin: 3,
} as const

export type MaterialReason =
  | { kind: 'board'; net: number; before: number }
  | { kind: 'department'; department: string; net: number; before: number }
  | { kind: 'opened'; department: string; now: number }
  | { kind: 'closed'; department: string; before: number }
  | { kind: 'cluster'; cluster: string; net: number; before: number }

export interface DepartmentMove {
  department: string
  added: number
  removed: number
  net: number
  /** Open roles before the moves and after them. */
  before: number
  now: number
  /** Ids of the clusters the department belongs to. */
  clusters: string[]
}

export interface BoardMove {
  provider: string
  added: number
  removed: number
  net: number
  before: number
  now: number
  /** Departments that moved, largest |net| first. */
  departments: DepartmentMove[]
  clusters: { id: string; label: string; net: number; before: number }[]
  /** Empty when the moves are below the floor. */
  material: MaterialReason[]
}

/** A count with its sign, minus as U+2212 the way the terminal prints it. */
export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0')

/** One line per reason, for the run report and the roll-up's explanation. */
export function describeReason(r: MaterialReason): string {
  switch (r.kind) {
    case 'board':
      return `net ${signed(r.net)} on a board of ${r.before}`
    case 'department':
      return `${r.department} ${signed(r.net)} of ${r.before}`
    case 'opened':
      return `${r.department} opened with ${r.now}`
    case 'closed':
      return `${r.department} closed (${r.before} to 0)`
    case 'cluster':
      return `${r.cluster} ${signed(r.net)} of ${r.before}`
  }
}

/** The department a job change adds to or removes from; null for a `modified`. */
function moveOf(change: ChangeRow): { department: string; by: 1 | -1 } | null {
  const json = change.change_type === 'added' ? change.after_json : change.before_json
  if (change.change_type === 'modified' || json === null) return null
  const department = (JSON.parse(json) as { department?: unknown }).department
  return {
    department: typeof department === 'string' && department ? department : NO_DEPARTMENT,
    by: change.change_type === 'added' ? 1 : -1,
  }
}

/**
 * Score one provider's job changes against its board as it stood right after
 * them (`after`: open roles per department). Pure: the D1 read is
 * boardMoves' job.
 */
export function scoreBoard(
  provider: string,
  changes: readonly ChangeRow[],
  after: ReadonlyMap<string, number>,
  clusters: readonly DepartmentCluster[],
): BoardMove {
  const tally = new Map<string, { added: number; removed: number }>()
  for (const change of changes) {
    const move = moveOf(change)
    if (!move) continue
    const t = tally.get(move.department) ?? { added: 0, removed: 0 }
    if (move.by > 0) t.added++
    else t.removed++
    tally.set(move.department, t)
  }

  const departments: DepartmentMove[] = [...tally]
    .map(([department, t]) => {
      const now = after.get(department) ?? 0
      const net = t.added - t.removed
      return {
        department,
        ...t,
        net,
        now,
        before: Math.max(0, now - net),
        clusters: clusters.filter((c) => inCluster(department, c)).map((c) => c.id),
      }
    })
    .filter((d) => d.added + d.removed > 0)
    .sort(
      (a, b) =>
        Math.abs(b.net) - Math.abs(a.net) ||
        b.added + b.removed - (a.added + a.removed) ||
        a.department.localeCompare(b.department),
    )

  const now = [...after.values()].reduce((n, v) => n + v, 0)
  const added = departments.reduce((n, d) => n + d.added, 0)
  const removed = departments.reduce((n, d) => n + d.removed, 0)
  const net = added - removed
  const before = Math.max(0, now - net)

  const F = HIRING_FLOOR
  const material: MaterialReason[] = []
  if (Math.abs(net) >= Math.max(F.boardMin, F.boardShare * before)) {
    material.push({ kind: 'board', net, before })
  }
  for (const d of departments) {
    if (d.net === 0) continue
    if (d.department !== NO_DEPARTMENT && d.before === 0 && d.now >= F.openCloseMin) {
      material.push({ kind: 'opened', department: d.department, now: d.now })
    } else if (d.department !== NO_DEPARTMENT && d.now === 0 && d.before >= F.openCloseMin) {
      material.push({ kind: 'closed', department: d.department, before: d.before })
    } else if (
      Math.abs(d.net) >= F.departmentMin &&
      Math.abs(d.net) >= F.departmentShare * d.before
    ) {
      material.push({ kind: 'department', department: d.department, net: d.net, before: d.before })
    }
  }
  const clusterMoves = clusters.map((c) => {
    const size = [...after]
      .filter(([department]) => inCluster(department, c))
      .reduce((n, [, v]) => n + v, 0)
    const cnet = departments.filter((d) => d.clusters.includes(c.id)).reduce((n, d) => n + d.net, 0)
    return { id: c.id, label: c.label, net: cnet, before: Math.max(0, size - cnet) }
  })
  for (const c of clusterMoves) {
    if (c.net !== 0 && Math.abs(c.net) >= Math.max(F.clusterMin, F.clusterShare * c.before)) {
      material.push({ kind: 'cluster', cluster: c.label, net: c.net, before: c.before })
    }
  }

  return {
    provider,
    added,
    removed,
    net,
    before,
    now,
    departments,
    clusters: clusterMoves.filter((c) => c.net !== 0),
    material,
  }
}

/**
 * Score job changes per provider, each against its board right after the
 * newest of them: the current open set with every later job change undone
 * (the same walk the hiring panel's history uses). Non-job changes are
 * ignored; a provider with no added/removed job change is left out.
 */
export async function boardMoves(
  db: PipelineDb,
  changes: readonly ChangeRow[],
  clusters: readonly DepartmentCluster[],
): Promise<BoardMove[]> {
  const byProvider = new Map<string, ChangeRow[]>()
  for (const c of changes) {
    if (c.entity_type !== 'job' || c.change_type === 'modified') continue
    byProvider.set(c.provider, [...(byProvider.get(c.provider) ?? []), c])
  }
  if (byProvider.size === 0) return []

  const providers = [...byProvider.keys()].sort()
  const asOf = new Map(
    providers.map((p) => [
      p,
      byProvider.get(p)!.reduce((m, c) => (c.detected_at > m ? c.detected_at : m), ''),
    ]),
  )
  const oldest = [...asOf.values()].sort()[0]!
  const department = sql<string | null>`json_extract(${tables.entities.payload}, '$.department')`
  const [roles, later] = await Promise.all([
    db
      .select({
        entity_key: tables.entities.entity_key,
        provider: tables.entities.provider,
        department,
      })
      .from(tables.entities)
      .where(
        and(eq(tables.entities.entity_type, 'job'), inArray(tables.entities.provider, providers)),
      ),
    db
      .select()
      .from(tables.changes)
      .where(
        and(
          eq(tables.changes.entity_type, 'job'),
          inArray(tables.changes.provider, providers),
          gt(tables.changes.detected_at, oldest),
        ),
      ),
  ])
  const current: OpenRole[] = roles.map((r) => ({
    entity_key: r.entity_key,
    provider: r.provider,
    department: r.department || NO_DEPARTMENT,
  }))

  return providers.map((provider) => {
    const instant = asOf.get(provider)!
    const counts = openRolesAt(
      current.filter((r) => r.provider === provider),
      later.filter((c) => c.provider === provider),
      [instant],
    )
    const after = counts.get(instant)?.get(provider) ?? new Map<string, number>()
    return scoreBoard(provider, byProvider.get(provider)!, after, clusters)
  })
}

/**
 * The `hiring` block of GET /api/judge/pending: per provider with job
 * changes pending, its board and department sizes and which moves clear the
 * floor, so the judge grades against the same numbers the Worker enforces.
 * The sizes are for deciding, never for printing: they are not in any change
 * record, so the grounding gate rejects an alert that quotes them.
 */
export async function hiringBoards(
  db: PipelineDb,
  pending: readonly ChangeRow[],
  clusters: readonly DepartmentCluster[],
) {
  const moves = await boardMoves(db, pending, clusters)
  return {
    floor: HIRING_FLOOR,
    boards: moves.map((m) => ({
      provider: m.provider,
      board_before: m.before,
      board_now: m.now,
      added: m.added,
      removed: m.removed,
      net: m.net,
      departments: m.departments,
      clusters: m.clusters,
      material: m.material.map(describeReason),
    })),
  }
}

/**
 * True when every cited change is a job change: the alerts the floor
 * governs. An alert that combines hiring with another axis (a price cut
 * beside a sales surge) is carried by its other rows and is left to the
 * judge.
 */
export const isHiringOnly = (cited: readonly ChangeRow[]): boolean =>
  cited.length > 0 && cited.every((c) => c.entity_type === 'job')

export interface FloorClamp {
  headline: string
  from: 'notable' | 'critical'
  detail: string
}

/**
 * Clamp every alert-tier, hiring-only alert whose cited changes are below
 * the floor to `info`. Only ever lowers a severity, so it cannot add an alert
 * or a critical (the tier social.ts posts). An alert is above the floor when
 * any provider it cites clears it.
 */
export async function clampHiringAlerts<
  A extends { severity: 'info' | 'notable' | 'critical'; headline: string; change_ids: string[] },
>(
  db: PipelineDb,
  alerts: readonly A[],
  supplied: readonly ChangeRow[],
  clusters: readonly DepartmentCluster[],
): Promise<{ alerts: A[]; clamped: FloorClamp[] }> {
  const byId = new Map(supplied.map((c) => [c.id, c]))
  const out: A[] = []
  const clamped: FloorClamp[] = []
  for (const alert of alerts) {
    const cited = alert.change_ids.flatMap((id) => byId.get(id) ?? [])
    if (alert.severity === 'info' || !isHiringOnly(cited)) {
      out.push(alert)
      continue
    }
    const moves = await boardMoves(db, cited, clusters)
    if (moves.some((m) => m.material.length > 0)) {
      out.push(alert)
      continue
    }
    const summary = moves.length
      ? moves.map((m) => `${m.provider} net ${signed(m.net)} on a board of ${m.before}`).join('; ')
      : 'no role added or removed'
    clamped.push({
      headline: alert.headline,
      from: alert.severity,
      detail: `below the hiring materiality floor (${summary})`,
    })
    out.push({ ...alert, severity: 'info' })
  }
  return { alerts: out, clamped }
}
