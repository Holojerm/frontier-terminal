// Point-in-time reads: what the terminal knew at an instant T, for the
// `as_of` query parameter on the routes and exports that can answer it.
//
// Knowledge time, not event time. A row counts at T when this store held it
// at T: a snapshot by its fetched_at, a change by its detected_at (the fetch
// that observed it), a run by its started_at. Anything written later about an
// earlier event — a judge alert, a re-read — is held back until it was
// written, which is the look-ahead an analyst backtesting against this data
// has to be protected from.
//
// The entity set is the one table rewritten in place, so its state at T is
// rebuilt: for each (entity_key, source_url), the content the first change
// after T replaced, else the current row if it was written by T. Each rebuilt
// row is checked against the newest change at or before T, because the log
// can miss a transition: change ids hash (key, before, after), so a role that
// closes and reopens twice logs the second pair as duplicates, which are
// skipped. A row whose two sides disagree is returned with its key in
// `unverified` rather than silently trusted. A gap that leaves both sides
// agreeing (a lost pair) cannot be seen from the log at all; the route docs
// say so.
//
// Tables rewritten in place WITHOUT a log (claim_readings, recipe_observations)
// cannot be rebuilt, and every surface that reads them refuses `as_of`.

import { and, desc, eq, gt, gte, lt, lte, min, ne, or, type SQL } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import { byString } from './terminal-json'

type Entity = typeof tables.entities.$inferSelect
type Change = typeof tables.changes.$inferSelect

export const AS_OF_PARAM = 'as_of'

/**
 * `as_of`: an ISO-8601 timestamp with a zone (Z or ±hh:mm), not in the
 * future, normalized to UTC milliseconds — the form every stored stamp has,
 * so a string compare against them is a time compare. A date or a zoneless
 * time is refused: "2026-10-01" is a different instant in every timezone.
 */
export const AsOfInstant = z
  .string()
  .trim()
  .pipe(
    z.iso.datetime({
      offset: true,
      error: 'as_of must be an ISO-8601 timestamp with a timezone, e.g. 2026-10-01T12:00:00Z',
    }),
  )
  .transform((s) => new Date(s).toISOString())
  .refine((iso) => Date.parse(iso) <= Date.now(), { error: 'as_of is in the future' })

export const AsOfQuery = z.object({ [AS_OF_PARAM]: AsOfInstant.optional() })

/** A request the store cannot answer as of T. Routes turn it into a 400. */
export class PointInTimeError extends Error {
  readonly statusCode = 400
}

/** getValidatedQuery's validator: h3 sends a throw's message as the 400's, so it is said plainly. */
export function parseAsOfQuery(query: unknown): { as_of?: string } {
  const parsed = AsOfQuery.safeParse(query)
  if (!parsed.success) {
    throw new PointInTimeError(parsed.error.issues.map((i) => i.message).join('; '))
  }
  return parsed.data
}

/** What a point-in-time payload carries beside its data, so a reader can audit how it was rebuilt. */
export interface PointInTimeMeta {
  /** The instant asked about, in UTC. The payload's own `as_of` is the newest poll tick at or before it. */
  requested: string
  /** How this payload was rebuilt from stored rows. */
  method: string[]
  /** Entity keys whose state at T the change log cannot confirm; their rows are the best reading, flagged. */
  unverified: string[]
}

/** A point-in-time payload: the live shape plus how it was rebuilt; null stays null. */
export type AsOfPayload<T> = T extends null ? null : T & { point_in_time: PointInTimeMeta }

/** Collected while a query runs; terminalPayload attaches it to the payload. */
export interface PointInTimeNotes {
  method: Set<string>
  unverified: Set<string>
}

export const pointInTimeNotes = (): PointInTimeNotes => ({
  method: new Set(),
  unverified: new Set(),
})

export function pointInTimeMeta(at: string, notes: PointInTimeNotes): PointInTimeMeta {
  return {
    requested: at,
    method: [...notes.method],
    unverified: [...notes.unverified].sort(byString),
  }
}

// ---- the floor and the stamp -----------------------------------------------

/** The first snapshot this store holds. One row per source, never a snapshot scan. */
export async function firstSnapshotAt(db: PipelineDb): Promise<string | null> {
  const [row] = await db
    .select({ at: min(tables.sourceStats.first_fetched_at) })
    .from(tables.sourceStats)
  return row?.at ?? null
}

/** Refuse an instant before anything was fetched: the store knew nothing then. */
export async function assertKnowable(db: PipelineDb, at: string): Promise<void> {
  const first = await firstSnapshotAt(db)
  if (first === null) throw new PointInTimeError('as_of: nothing has been fetched yet')
  if (at < first) {
    throw new PointInTimeError(
      `as_of ${at} is before the first snapshot (${first}), so we had no data then`,
    )
  }
}

/** The poll tick in force at `at`: what the payload's `as_of` would have said then. */
export async function pollStampAt(db: PipelineDb, at: string): Promise<string | null> {
  const [row] = await db
    .select({ at: tables.sourceRuns.started_at })
    .from(tables.sourceRuns)
    .where(lte(tables.sourceRuns.started_at, at))
    .orderBy(desc(tables.sourceRuns.started_at))
    .limit(1)
  return row?.at ?? null
}

// ---- alerts ----------------------------------------------------------------

/**
 * The newest judge run at or before `at` that accepted an alert. A judge
 * alert's created_at is its newest cited change's fetch, but the row is
 * written by a judge run up to hours later, so it is held back until a run
 * that could have written it had started.
 */
export async function judgeCutoffAt(db: PipelineDb, at: string): Promise<string | null> {
  const [row] = await db
    .select({ at: tables.judgeRuns.started_at })
    .from(tables.judgeRuns)
    .where(and(lte(tables.judgeRuns.started_at, at), gt(tables.judgeRuns.accepted, 0)))
    .orderBy(desc(tables.judgeRuns.started_at))
    .limit(1)
  return row?.at ?? null
}

export const JUDGE_RULE = 'agent-judge'

/**
 * Alerts the store held at `at`. Deterministic rules write their alert in the
 * tick that detected the change, stamped with that detection; a judge alert
 * also needs a judge run between its newest cited change and `at`.
 */
export function alertsKnownAt(at: string, judgeCutoff: string | null): SQL {
  const notJudge = ne(tables.alerts.rule, JUDGE_RULE)
  return and(
    lte(tables.alerts.created_at, at),
    judgeCutoff === null ? notJudge : or(notJudge, lte(tables.alerts.created_at, judgeCutoff)),
  )!
}

export const ALERTS_METHOD =
  'Alerts with created_at at or before as_of. A judge alert (rule agent-judge) is written by a judge run after the changes it cites, and is held back until a judge run that accepted alerts had started (judge_runs.started_at). One that a later run wrote about an older change can still appear early, because an alert row doesn’t record which run wrote it.'

// ---- the entity set at T -----------------------------------------------------

/** Rows of `entity_type` by the entity_key prefix every key carries
 * (contracts/keys.ts), so the read is a range on the entity_key index rather
 * than a scan of the table. The type test stays as a residual guard. */
export function keyPrefixRange(
  column: typeof tables.entities.entity_key | typeof tables.changes.entity_key,
  type: string,
): SQL {
  // ';' sorts right after ':', so [type:, type;) is exactly the keys under type:.
  return and(gte(column, `${type}:`), lt(column, `${type};`))!
}

export interface FirstFetch {
  source_id: string
  fetched_at: string
}

export interface Rewound {
  /** The entity rows as the store held them at T. */
  rows: Entity[]
  /** Every change of the type at or before T, oldest first. */
  changes: Change[]
  /** Keys whose state at T the log does not confirm. */
  unverified: string[]
}

const groupKey = (key: string, url: string) => `${key}\n${url}`

interface State {
  hash: string
  payload: string
  /** The fetch that observed this content. */
  fetched_at: string | null
}

/**
 * Pure: the entity set at `at`, from the current set and every change of the
 * same type (in any order). `firstFetchOf(url)` is the source's first
 * snapshot — a row with no change before it was there from that baseline.
 */
export function entitiesAt(
  current: readonly Entity[],
  changes: readonly Change[],
  at: string,
  firstFetchOf: (url: string) => FirstFetch | null,
): Rewound {
  const groups = new Map<string, { cur: Entity | null; log: Change[] }>()
  for (const e of current) {
    groups.set(groupKey(e.entity_key, e.source_url), { cur: e, log: [] })
  }
  for (const c of changes) {
    const k = groupKey(c.entity_key, c.source_url)
    const g = groups.get(k) ?? { cur: null, log: [] }
    g.log.push(c)
    groups.set(k, g)
  }

  const rows: Entity[] = []
  const unverified = new Set<string>()
  const known: Change[] = []
  for (const { cur, log } of groups.values()) {
    log.sort((a, b) => byString(a.detected_at, b.detected_at) || byString(a.id, b.id))
    const split = log.findIndex((c) => c.detected_at > at)
    const before = split === -1 ? log : log.slice(0, split)
    known.push(...before)
    const prev = before.at(-1) ?? null
    const next = split === -1 ? null : log[split]!
    const sample = (cur ?? log[0])!
    const url = sample.source_url
    const first = firstFetchOf(url)

    // The state at T, and whether the log on the near side of T agrees.
    let state: State | null
    let confirmed = true
    if (next) {
      state =
        next.change_type === 'added' || next.before_hash === null || next.before_json === null
          ? null
          : {
              hash: next.before_hash,
              payload: next.before_json,
              fetched_at: prev?.fetched_at ?? null,
            }
    } else if (cur && cur.fetched_at <= at) {
      state = { hash: cur.content_hash, payload: cur.payload, fetched_at: cur.fetched_at }
    } else if (prev) {
      // Rewritten after T with no change row (a re-hash, a skipped duplicate),
      // or deleted with none: the log's own newest state is the reading at T.
      state = afterOf(prev)
      if (!cur) confirmed = false // a deletion is undated, so it may have been before T
    } else if (cur && cur.first_seen_at <= at) {
      // Present since a baseline before T, rewritten after it, unlogged: the
      // content at T is unknown. The current content is the best reading.
      state = { hash: cur.content_hash, payload: cur.payload, fetched_at: cur.first_seen_at }
      confirmed = false
    } else {
      state = null
    }

    if (prev) {
      const expected = prev.change_type === 'removed' ? null : prev.after_hash
      if ((state?.hash ?? null) !== expected) confirmed = false
    } else if (state) {
      // No change before T: the row came from the source's baseline, which
      // must itself predate T.
      const baseline =
        cur && cur.first_seen_at <= at ? cur.first_seen_at : (first?.fetched_at ?? null)
      if (baseline === null) confirmed = false
      else if (baseline > at) state = null
      else state.fetched_at ??= baseline
    }

    // An uncertain absence is flagged too: the key may have been listed at T.
    if (!confirmed) unverified.add(sample.entity_key)
    if (!state) continue

    const source_id = cur?.source_id ?? first?.source_id ?? '(unknown source)'
    const fetched_at = state.fetched_at ?? first?.fetched_at ?? at
    const lastAdded = before.findLast((c) => c.change_type === 'added')
    rows.push({
      source_id,
      entity_key: sample.entity_key,
      entity_type: sample.entity_type,
      provider: sample.provider,
      content_hash: state.hash,
      payload: state.payload,
      snapshot_id: `${source_id}:${fetched_at}`,
      first_seen_at:
        lastAdded?.detected_at ??
        (cur && cur.first_seen_at <= at ? cur.first_seen_at : (first?.fetched_at ?? fetched_at)),
      source_url: url,
      fetched_at,
    })
  }

  rows.sort((a, b) => byString(a.source_id, b.source_id) || byString(a.entity_key, b.entity_key))
  known.sort((a, b) => byString(a.detected_at, b.detected_at) || byString(a.id, b.id))
  return { rows, changes: known, unverified: [...unverified].sort(byString) }
}

function afterOf(change: Change): State | null {
  if (
    change.change_type === 'removed' ||
    change.after_hash === null ||
    change.after_json === null
  ) {
    return null
  }
  return { hash: change.after_hash, payload: change.after_json, fetched_at: change.fetched_at }
}

export const ENTITY_METHOD =
  'Entity rows rebuilt from the current set and the change log: per key, the content the first change after as_of replaced, else the current row if it was written by then. Keys in unverified are where the newest change at or before as_of disagrees with that reading. The log skips a repeated identical change, so a gap can exist that no row shows.'

/** First snapshot per source URL: when a source's baseline could have been written. */
export async function firstFetchByUrl(db: PipelineDb): Promise<Map<string, FirstFetch>> {
  const rows = await db
    .selectDistinct({
      source_id: tables.snapshots.source_id,
      source_url: tables.snapshots.source_url,
      fetched_at: tables.snapshots.fetched_at,
    })
    .from(tables.sourceStats)
    .crossJoin(tables.snapshots)
    .where(
      and(
        eq(tables.snapshots.source_id, tables.sourceStats.source_id),
        eq(tables.snapshots.fetched_at, tables.sourceStats.first_fetched_at),
      ),
    )
  const out = new Map<string, FirstFetch>()
  for (const r of rows) {
    const held = out.get(r.source_url)
    if (!held || r.fetched_at < held.fetched_at) out.set(r.source_url, r)
  }
  return out
}

/**
 * The entity set of one type at `at` — or of one key, when `key` is given.
 * Two indexed reads: the current rows and the type's whole change log, by
 * key prefix (or by key). The log is what the live price and hiring
 * queries already read in full; nothing here touches snapshots beyond the
 * one-row-per-source first fetch.
 */
export async function rewindEntities(
  db: PipelineDb,
  type: string,
  at: string,
  key?: string,
): Promise<Rewound> {
  const entityWhere = key
    ? and(eq(tables.entities.entity_key, key), eq(tables.entities.entity_type, type))
    : and(keyPrefixRange(tables.entities.entity_key, type), eq(tables.entities.entity_type, type))
  const changeWhere = key
    ? and(eq(tables.changes.entity_key, key), eq(tables.changes.entity_type, type))
    : and(keyPrefixRange(tables.changes.entity_key, type), eq(tables.changes.entity_type, type))
  const [current, changes, firsts] = await Promise.all([
    db.select().from(tables.entities).where(entityWhere),
    db.select().from(tables.changes).where(changeWhere),
    firstFetchByUrl(db),
  ])
  return entitiesAt(current, changes, at, (url) => firsts.get(url) ?? null)
}

// ---- refusals --------------------------------------------------------------

/** Every surface that answers `as_of`, for the 400 a refusing one sends. */
export const AS_OF_ROUTES = [
  '/api/alerts',
  '/api/prices',
  '/api/prices/<key>',
  '/api/hiring',
  '/api/hiring/history',
  '/api/revenue',
  '/api/track-record',
] as const

export function asOfRefusal(what: string, reason: string, also: string): string {
  return `as_of is not supported on ${what}: ${reason} Point-in-time reads are served by ${AS_OF_ROUTES.join(', ')} and ${also}.`
}
