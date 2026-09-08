// Three derived views of the history the store already holds, as pure
// functions over rows: a SKU's price series, open roles per day, and the
// model-release timeline. terminal-db.ts fetches the rows; nothing here
// touches D1, so test/terminal-history.test.ts drives every rule with a
// handful of fixture rows.
//
// The store keeps the CURRENT entity set plus an append-only change log
// (server/db/schema.ts), so every past state is the current state with the
// changes after that instant undone. That is the one derivation rule here,
// applied three ways. No clock is read: `now` is an argument.

import type {
  DeptCompare,
  DeptSeries,
  HiringCompare,
  PricePoint,
  ReleaseView,
} from '#shared/utils/terminal-types'

import type * as tables from '../db/schema'
import { byString, fieldDiff, num, parseJson, str } from './terminal-json'

type Change = typeof tables.changes.$inferSelect
type Entity = typeof tables.entities.$inferSelect

const at = (iso: string) => Date.parse(iso)

/** Ascending by time, then id, so output order never depends on input order. */
export function byDetectedAt(a: Change, b: Change): number {
  return at(a.detected_at) - at(b.detected_at) || byString(a.id, b.id)
}

// ---- baseline --------------------------------------------------------------

/**
 * The (source_url, fetched_at) pairs of every baseline fetch: the first
 * snapshot each source ever produced, plus any snapshot a source_runs row
 * marks 'baseline'. This Worker's baseline writes entities and no change
 * rows (server/pipeline/refresh.ts), so the first form is what matters for
 * imported history — the take-home's Google lane logged its first parse as
 * an `added` row per SKU, and those are first sightings of a watcher, not
 * of a model.
 */
export function baselineInstants(
  snapshots: readonly Pick<
    typeof tables.snapshots.$inferSelect,
    'id' | 'source_url' | 'fetched_at'
  >[],
  runs: readonly Pick<typeof tables.sourceRuns.$inferSelect, 'status' | 'snapshot_id'>[],
): Set<string> {
  const first = new Map<string, string>()
  for (const s of snapshots) {
    const seen = first.get(s.source_url)
    if (seen === undefined || at(s.fetched_at) < at(seen)) first.set(s.source_url, s.fetched_at)
  }
  const out = new Set<string>()
  for (const [url, fetched] of first) out.add(`${url}\n${fetched}`)
  const byId = new Map(snapshots.map((s) => [s.id, s]))
  for (const run of runs) {
    if (run.status !== 'baseline' || !run.snapshot_id) continue
    const snap = byId.get(run.snapshot_id)
    if (snap) out.add(`${snap.source_url}\n${snap.fetched_at}`)
  }
  return out
}

export const isBaseline = (change: Change, instants: ReadonlySet<string>): boolean =>
  change.change_type === 'added' && instants.has(`${change.source_url}\n${change.fetched_at}`)

// ---- price history ---------------------------------------------------------

/**
 * Every observation of one SKU key, oldest first. Each change row is a
 * point (a removal carries the last price seen); each current entity row is
 * a 'current' point unless it is the same fetch a change already recorded —
 * an entity rewrite and its change share a fetched_at. When the earliest
 * change carries a before state, that state held from the source's first
 * snapshot until the change (any move in between would be in the log), so
 * it opens the series as a 'baseline' point stamped with that snapshot.
 */
export function priceHistory(
  entities: readonly Entity[],
  changes: readonly Change[],
  sourceIdOf: (url: string) => string,
  firstSnapshotOf: (url: string) => string | null = () => null,
): PricePoint[] {
  const points: PricePoint[] = []
  const seen = new Set<string>()
  const point = (
    kind: PricePoint['kind'],
    when: string,
    payload: Record<string, unknown>,
    source_url: string,
    fetched_at: string,
    diff: PricePoint['diff'] = [],
  ): PricePoint => ({
    at: when,
    kind,
    source_id: sourceIdOf(source_url),
    input_per_mtok: num(payload.input_per_mtok),
    cached_input_per_mtok: num(payload.cached_input_per_mtok),
    output_per_mtok: num(payload.output_per_mtok),
    diff,
    source_url,
    fetched_at,
  })

  const sorted = [...changes].sort(byDetectedAt)
  const earliest = sorted[0]
  const opening = earliest ? parseJson(earliest.before_json) : null
  if (earliest && opening) {
    const first = firstSnapshotOf(earliest.source_url)
    if (first !== null && at(first) < at(earliest.detected_at)) {
      points.push(point('baseline', first, opening, earliest.source_url, first))
    }
  }
  for (const c of sorted) {
    const before = parseJson(c.before_json)
    const after = parseJson(c.after_json)
    const payload = c.change_type === 'removed' ? before : after
    if (!payload) continue
    seen.add(`${c.source_url}\n${c.fetched_at}`)
    const diff = c.change_type === 'modified' ? fieldDiff(before, after) : []
    points.push(
      point(
        c.change_type as PricePoint['kind'],
        c.detected_at,
        payload,
        c.source_url,
        c.fetched_at,
        diff,
      ),
    )
  }
  for (const e of [...entities].sort((a, b) => byString(a.source_id, b.source_id))) {
    if (seen.has(`${e.source_url}\n${e.fetched_at}`)) continue
    const payload = parseJson(e.payload)
    if (payload) points.push(point('current', e.fetched_at, payload, e.source_url, e.fetched_at))
  }
  // A current point observed in the same instant as a change sorts after it.
  return points.sort(
    (a, b) => at(a.at) - at(b.at) || Number(a.kind === 'current') - Number(b.kind === 'current'),
  )
}

/** The sparkline's series: input prices when any exist, else output; null under two points. */
export function sparkOf(
  points: readonly PricePoint[],
): { field: 'input_per_mtok' | 'output_per_mtok'; values: (number | null)[] } | null {
  if (points.length < 2) return null
  const field = points.some((p) => p.input_per_mtok !== null) ? 'input_per_mtok' : 'output_per_mtok'
  return { field, values: points.map((p) => p[field]) }
}

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

// ---- releases --------------------------------------------------------------

/**
 * "New SKU listed" events: every `added` change on a model row that is not
 * a baseline sighting, newest first. The price is the one printed beside
 * the listing when it was first seen; a later reprice is on the SKU's page.
 * Two pages listing one key (the Anthropic pair) are one release: the
 * earliest sighting is the row, a priced one first on a tie, and the other
 * page is cited on it.
 */
export function releaseEvents(
  changes: readonly Change[],
  baseline: ReadonlySet<string>,
  sourceIdOf: (url: string) => string,
): { rows: ReleaseView[]; excluded_baseline: number } {
  const sightings: ReleaseView[] = []
  let excluded = 0
  for (const c of [...changes].sort(byDetectedAt)) {
    if (c.entity_type !== 'model' || c.change_type !== 'added') continue
    if (isBaseline(c, baseline)) {
      excluded++
      continue
    }
    const after = parseJson(c.after_json)
    if (!after || typeof after.model_slug !== 'string') continue
    sightings.push({
      change_id: c.id,
      entity_key: c.entity_key,
      source_id: sourceIdOf(c.source_url),
      provider: c.provider as ReleaseView['provider'],
      model_slug: after.model_slug,
      tier: str(after.tier),
      context_window: str(after.context_window),
      first_seen_at: c.detected_at,
      input_per_mtok: num(after.input_per_mtok),
      cached_input_per_mtok: num(after.cached_input_per_mtok),
      output_per_mtok: num(after.output_per_mtok),
      notes: str(after.notes),
      also_listed_by: [],
      source_url: c.source_url,
      fetched_at: c.fetched_at,
    })
  }
  const priced = (r: ReleaseView) => r.input_per_mtok !== null || r.output_per_mtok !== null
  const byKey = new Map<string, ReleaseView>()
  for (const s of sightings) {
    const held = byKey.get(s.entity_key)
    if (!held) {
      byKey.set(s.entity_key, s)
      continue
    }
    const sameInstant = at(held.first_seen_at) === at(s.first_seen_at)
    if (sameInstant && !priced(held) && priced(s)) {
      s.also_listed_by = [...held.also_listed_by, held.source_id]
      byKey.set(s.entity_key, s)
    } else {
      held.also_listed_by.push(s.source_id)
    }
  }
  const rows = [...byKey.values()]
  for (const r of rows) r.also_listed_by.sort(byString)
  rows.sort(
    (a, b) =>
      at(b.first_seen_at) - at(a.first_seen_at) ||
      byString(a.provider, b.provider) ||
      byString(a.entity_key, b.entity_key),
  )
  return { rows, excluded_baseline: excluded }
}
