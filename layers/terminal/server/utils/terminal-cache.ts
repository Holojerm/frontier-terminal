// A KV cache for the terminal payloads, keyed by the poll tick. The TTL is
// garbage collection only (TERMINAL_CACHE_TTL_SECONDS); freshness comes from the key.
//
// The key carries the newest source_runs.started_at and the newest write of
// every writer outside the poll (terminalStamps), so a poll or a judge run
// invalidates every cached payload by construction: the next request computes against
// the new stamp and the old entries expire on their own. Nothing has to be
// evicted, and a reader can never be served a payload from before the tick
// the page says it reflects.
//
// Fails OPEN. A KV hiccup must not take the terminal down: the payload is
// recomputed from D1 and the miss is logged. Takes the store explicitly so
// layers/terminal/test/terminal-cache.test.ts drives it with a Map.

import { max, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import { timed, type ServerTimings } from './server-timing'

/** The slice of unstorage's Storage the cache uses — lets tests pass a Map-backed fake. */
export interface CacheStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, opts?: { ttl?: number }): Promise<unknown>
}

/**
 * Sized off the poll cadence, not off a feeling about freshness.
 *
 * The key carries the poll stamp, so an entry cannot outlive the tick it
 * describes: the next poll rotates every key and the old ones are orphaned
 * whatever their TTL. The TTL is therefore a garbage-collection deadline, not
 * a staleness bound, and shortening it cannot make a payload fresher — it can
 * only throw away a still-correct entry and make some reader recompute it from
 * D1.
 *
 * At the previous 300s that happened five times per 30-minute poll window, and
 * because all the payloads share one stamp they expired together: one unlucky
 * reader recomputed all eight from scratch. 40 minutes clears the half-hourly
 * poll with slack, so an entry now expires only after it is already orphaned.
 */
export const TERMINAL_CACHE_TTL_SECONDS = 2400

/** The newest poll tick, or null before the first one. Every payload's `as_of`. */
export async function terminalStamp(db: PipelineDb): Promise<string | null> {
  const [row] = await db.select({ at: max(tables.sourceRuns.started_at) }).from(tables.sourceRuns)
  return row?.at ?? null
}

export interface TerminalStamps {
  /** The newest poll tick (terminalStamp): the payloads' `as_of`. */
  poll: string | null
  /** What the KV and HTML caches key on: the poll tick and every later writer. Null before anything was written. */
  key: string | null
}

/**
 * The poll tick plus the newest write of each writer that changes a served
 * payload outside the poll: the judge (alerts, class-map decisions, claim and
 * track-record verdicts; its judge_runs row is written last), other alert
 * writers (the hiring rollup, exposure ingest), the thesis evaluation (it runs
 * after the survey's recipes, so it also moves past their writes), the GDELT
 * files and track-record searches, and the filed-fact reads. Keyed on the
 * poll alone, a judge run left every page on the payload from before it until
 * the next poll. One statement: each subquery is a max() on an indexed
 * column, except track_record_searches, a row per alert per source.
 */
export async function terminalStamps(db: PipelineDb): Promise<TerminalStamps> {
  const [row] = await db.all<Record<string, string | null>>(
    sql`select
      (select max(started_at) from source_runs) as poll,
      (select max(started_at) from judge_runs) as judge,
      (select max(created_at) from alerts) as alerts,
      (select max(computed_at) from claim_readings) as readings,
      (select max(recorded_at) from gdelt_files) as gkg,
      (select max(searched_at) from track_record_searches) as searches,
      (select max(started_at) from filed_fact_reads) as filed`,
  )
  const poll = row?.poll ?? null
  const writes = WRITERS.map((w) => row?.[w] ?? null)
  if (poll === null && writes.every((w) => w === null)) return { poll, key: null }
  return { poll, key: [poll ?? 'never-polled', ...writes.map((w) => w ?? '-')].join('+') }
}

const WRITERS = ['judge', 'alerts', 'readings', 'gkg', 'searches', 'filed'] as const

/**
 * The stamp read currently in flight, if any. Module scope, so it is per
 * isolate rather than per request — which is the point.
 */
let inFlightStamp: { promise: Promise<unknown>; startedAt: number } | null = null

/**
 * `terminalStamp`, de-duplicated across concurrent callers.
 *
 * Rendering the front page fans out to eight endpoints, and each one used to
 * ask D1 for `max(source_runs.started_at)` independently: eight identical
 * queries, eight round-trips, one answer. They all start within a few
 * milliseconds of each other, so sharing the first one's promise collapses them
 * into a single query without changing a single result.
 *
 * This is NOT a cache and deliberately not written as one. The promise is
 * dropped the moment it settles, so the next caller reads D1 again — there is no
 * TTL and no window in which a stale stamp can be handed out. The only sharing
 * is between reads that genuinely overlap in time, which is a tighter window
 * than D1's own read consistency.
 *
 * A rejection is shared too, so eight fan-out calls report one 503 rather than
 * eight — and because the slot is cleared on settle, the next request retries.
 *
 * `terminalStamp` itself stays an unmemoized read: callers that drive it across
 * writes to the same database must see each new value.
 */
export function sharedTerminalStamp<T>(
  read: () => Promise<T>,
  waitMs = STAMP_SHARE_WAIT_MS,
  now: () => number = Date.now,
): Promise<T> {
  const slot = inFlightStamp
  if (slot && now() - slot.startedAt < waitMs) {
    // Every production caller reads terminalStamps, so a joined slot is a T.
    return joinOrReadOwn(slot.promise as Promise<T>, read, waitMs - (now() - slot.startedAt))
  }
  const tracked = read().finally(() => {
    if (inFlightStamp?.promise === tracked) inFlightStamp = null
  })
  inFlightStamp = { promise: tracked, startedAt: now() }
  return tracked
}

/**
 * How long a caller waits on another caller's stamp read before issuing its own.
 *
 * The slot is per isolate, so concurrent *requests* share it, not just one
 * render's fan-out. Workers ties a D1 read to the request that started it: if
 * that request is cancelled (a reader closes the tab) the read never settles,
 * and a promise from an ended request context is dropped rather than resolved
 * in another (the handle_cross_request_promise_resolution flag). Before this
 * bound, every later page request in the isolate joined that dead promise and
 * hung with no bytes sent; frontierterm.com did exactly that on 2026-11-07.
 * A healthy stamp read takes 10–90ms, so a second's wait costs nothing on the
 * normal path, and an abandoned slot is replaced after it.
 */
export const STAMP_SHARE_WAIT_MS = 1000

/** The shared read if it lands within `budgetMs`, else this caller's own read. The timer lives in the caller's context, so it always fires. */
async function joinOrReadOwn<T>(
  shared: Promise<T>,
  read: () => Promise<T>,
  budgetMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<{ late: true }>((resolve) => {
    timer = setTimeout(() => resolve({ late: true }), Math.max(0, budgetMs))
  })
  try {
    const first = await Promise.race([
      shared.then((value) => ({ late: false as const, value })),
      late,
    ])
    return first.late ? await read() : first.value
  } finally {
    clearTimeout(timer)
  }
}

export function terminalCacheKey(name: string, stamp: string | null): string {
  return `terminal:${name}:${stamp ?? 'never-polled'}`
}

/**
 * How long a KV read may take before the recompute starts alongside it.
 *
 * A key this colo has read recently answers in 3–20ms. A key it has not —
 * the normal case on this site, where the cache:warm cron writes from one
 * data centre and readers arrive in others — took 0.5–2.6s in production on
 * 2026-11-04, whatever the value's size, while the recompute it stands in for
 * takes 10–700ms. Past this budget the read is almost certainly cold, so the
 * reader gets whichever of the two finishes first.
 */
export const KV_HEDGE_MS = 100

export interface CacheOptions {
  /** Collects Server-Timing stages for the caller's response. */
  timings?: ServerTimings
  /**
   * The request's waitUntil. Given one, the write on a miss runs after the
   * response is sent: a KV put costs 200–350ms in production, which a reader
   * was paying on top of the recompute for a value they already had.
   */
  defer?: (promise: Promise<unknown>) => void
  /** Overrides KV_HEDGE_MS; tests use it to make the race deterministic. */
  hedgeMs?: number
}

type Read<T> = { found: true; value: T } | { found: false }

/**
 * Serve `name` for the tick `stamp` from the store, computing and storing it
 * on a miss. `compute` runs at most once per (name, stamp) per TTL
 * under normal conditions; under a failing store it runs every time, which
 * is slower and still correct. A slow read is hedged (KV_HEDGE_MS).
 */
export async function cachedTerminal<T>(
  store: CacheStore,
  name: string,
  stamp: string | null,
  compute: () => Promise<T>,
  { timings, defer, hedgeMs = KV_HEDGE_MS }: CacheOptions = {},
): Promise<T> {
  const key = terminalCacheKey(name, stamp)
  const startedAt = Date.now()
  const read: Promise<Read<T>> = store.get(key).then(
    (hit) =>
      hit !== null && hit !== undefined ? { found: true, value: hit as T } : { found: false },
    (error: unknown) => {
      console.warn(
        JSON.stringify({ kind: 'terminal_cache_unavailable', name, error: String(error) }),
      )
      return { found: false }
    },
  )
  const mark = (desc: string) => timings?.push({ name: 'kv', dur: Date.now() - startedAt, desc })

  const write = async (value: T) => {
    try {
      await store.set(key, value, { ttl: TERMINAL_CACHE_TTL_SECONDS })
    } catch (error) {
      console.warn(
        JSON.stringify({ kind: 'terminal_cache_write_failed', name, error: String(error) }),
      )
    }
  }
  const persist = async (value: T) => {
    if (defer) defer(write(value))
    else await timed(timings, 'kv-put', () => write(value))
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => resolve('slow'), hedgeMs)
  })
  const first = await Promise.race([read, slow])
  clearTimeout(timer)

  if (first !== 'slow') {
    mark(first.found ? 'hit' : 'miss')
    if (first.found) return first.value
    const value = await timed(timings, 'compute', compute)
    await persist(value)
    return value
  }

  // Cold read: race it against the recompute, first success wins. A failed
  // recompute still loses to a hit, and the loser is left to finish. The value
  // is written only if the read turns out to be a miss.
  const computed = timed(timings, 'compute', compute)
  const fromRead = read.then((r) =>
    r.found
      ? { value: r.value, via: 'slow-hit' }
      : computed.then((value) => ({ value, via: 'slow' })),
  )
  const fromCompute = computed.then((value) => ({ value, via: 'slow' }))
  let winner: { value: T; via: string }
  try {
    winner = await Promise.any([fromRead, fromCompute])
  } catch (error) {
    throw error instanceof AggregateError ? error.errors[0] : error
  }
  mark(winner.via)
  const settle = read.then(async (r) => {
    if (!r.found) await write(winner.value)
  })
  // Without a waitUntil there is nothing to hold the request open for the
  // write, and waiting would hand the reader the slow read back.
  if (defer) defer(settle)
  else void settle
  return winner.value
}
