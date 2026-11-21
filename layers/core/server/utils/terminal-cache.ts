// A KV cache for the terminal payloads, keyed by the poll tick. The TTL is
// garbage collection only (TERMINAL_CACHE_TTL_SECONDS); freshness comes from the key.
//
// The key carries the newest source_runs.started_at and the newest write of every
// writer outside the poll (terminalStamps), so a poll or a judge run invalidates
// every cached payload by construction: nothing is evicted, and a reader never
// gets a payload older than the tick the page says it reflects.
//
// Fails open: on a KV error the payload is recomputed from D1 and the miss is
// logged. Takes the store explicitly so layers/core/test/terminal-cache.test.ts
// drives it with a Map.

import { sql } from 'drizzle-orm'

import type { PipelineDb } from './pipeline-store'
import { timed, type ServerTimings } from './server-timing'

/** The slice of unstorage's Storage the cache uses, so tests can pass a Map-backed fake. */
export interface CacheStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, opts?: { ttl?: number }): Promise<unknown>
}

/**
 * The key carries the poll stamp, so the next poll orphans every entry whatever
 * its TTL. The TTL is a garbage-collection deadline, not a staleness bound:
 * shortening it only throws away correct entries and makes a reader recompute
 * from D1. The payloads share one stamp and expire together, so an early expiry
 * makes one reader recompute all of them. 40 minutes clears the half-hourly poll
 * with slack, so an entry expires only once it is orphaned.
 */
export const TERMINAL_CACHE_TTL_SECONDS = 2400

export interface TerminalStamps {
  /** The newest poll tick (max source_runs.started_at), or null before the first one: every payload's `as_of`. */
  poll: string | null
  /** What the KV and HTML caches key on: the poll tick and every later writer. Null before anything was written. */
  key: string | null
}

/**
 * The poll tick plus the newest write of each writer that changes a served
 * payload outside the poll: the judge (its alerts, its judge_runs row, then the
 * class-map decisions and the claim and track-record verdicts, which land after
 * that row and so are keyed on their own), other alert writers (the hiring
 * rollup, exposure ingest), the thesis evaluation (it runs after the survey's
 * recipes), the track-record searches and the candidates they and the GDELT
 * backfill find, and the filed-fact reads. One statement, each subquery a max()
 * on an indexed column. A route's own variant adds only what this can't see:
 * its input, or a stamp from a table outside this list.
 */
export async function terminalStamps(db: PipelineDb): Promise<TerminalStamps> {
  const [row] = await db.all<Record<string, string | null>>(
    sql`select
      (select max(started_at) from source_runs) as poll,
      (select max(started_at) from judge_runs) as judge,
      (select max(created_at) from alerts) as alerts,
      (select max(decided_at) from class_map_decisions) as classes,
      (select max(computed_at) from claim_readings) as readings,
      (select max(judged_at) from claim_verdicts) as verdicts,
      (select max(judged_at) from track_record_verdicts) as ratings,
      (select max(found_at) from track_record_candidates) as candidates,
      (select max(searched_at) from track_record_searches) as searches,
      (select max(started_at) from filed_fact_reads) as filed`,
  )
  const poll = row?.poll ?? null
  const writes = WRITERS.map((w) => row?.[w] ?? null)
  if (poll === null && writes.every((w) => w === null)) return { poll, key: null }
  return { poll, key: [poll ?? 'never-polled', ...writes.map((w) => w ?? '-')].join('+') }
}

const WRITERS = [
  'judge',
  'alerts',
  'classes',
  'readings',
  'verdicts',
  'ratings',
  'candidates',
  'searches',
  'filed',
] as const

/** The stamp read in flight, if any. Module scope, so it is shared per isolate, not per request. */
let inFlightStamp: { promise: Promise<unknown>; startedAt: number } | null = null

/**
 * `terminalStamps`, de-duplicated across concurrent callers. The front page fans
 * out to eight endpoints that start within milliseconds of each other, so
 * sharing the first one's promise turns eight identical D1 queries into one.
 *
 * Not a cache: the promise is dropped when it settles, so the next caller reads
 * D1 again. Only reads that overlap in time share, a tighter window than D1's
 * own read consistency. A rejection is shared too (one 503, not eight), and the
 * cleared slot lets the next request retry.
 *
 * `terminalStamps` itself stays unmemoized: callers that drive it across writes
 * to the same database must see each new value.
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
 * The slot is per isolate, so concurrent requests share it. Workers ties a D1
 * read to the request that started it: if that request is cancelled (a reader
 * closes the tab) the read never settles, and a promise from an ended request
 * context is dropped rather than resolved in another (the
 * handle_cross_request_promise_resolution flag). Unbounded, every later page
 * request in the isolate would join that dead promise and hang with no bytes
 * sent. A healthy stamp read takes 10–90ms, so a second's wait costs nothing
 * normally, and an abandoned slot is replaced after it.
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
 * A key this colo read recently answers in 3–20ms. A cold key (the normal case
 * here: the cache:warm cron writes from one data center and readers arrive in
 * others) took 0.5–2.6s in production whatever the value's size, while the
 * recompute takes 10–700ms. Past this budget the read is almost certainly cold,
 * so the reader gets whichever of the two finishes first.
 */
export const KV_HEDGE_MS = 100

export interface CacheOptions {
  /** Collects Server-Timing stages for the caller's response. */
  timings?: ServerTimings
  /**
   * The request's waitUntil. Given one, the write on a miss runs after the
   * response is sent, since a KV put costs 200–350ms in production.
   */
  defer?: (promise: Promise<unknown>) => void
  /** Overrides KV_HEDGE_MS; tests use it to make the race deterministic. */
  hedgeMs?: number
}

type Read<T> = { found: true; value: T } | { found: false }

/**
 * Serve `name` for the tick `stamp` from the store, computing and storing it on
 * a miss. `compute` runs at most once per (name, stamp) per TTL normally, and
 * every time under a failing store (slower, still correct). A slow read is
 * hedged (KV_HEDGE_MS).
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
