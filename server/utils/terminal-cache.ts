// A five-minute KV cache for the terminal payloads, keyed by the poll tick.
//
// The key carries the newest source_runs.started_at, so a poll invalidates
// every cached payload by construction: the next request computes against
// the new stamp and the old entries expire on their own. Nothing has to be
// evicted, and a reader can never be served a payload from before the tick
// the page says it reflects.
//
// Fails OPEN. A KV hiccup must not take the terminal down: the payload is
// recomputed from D1 and the miss is logged. Takes the store explicitly so
// test/terminal-cache.test.ts drives it with a Map.

import { max } from 'drizzle-orm'

import * as tables from '../db/schema'
import type { PipelineDb } from '../pipeline/store'

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

/** The newest poll tick, or null before the first one. The cache key and every payload's `as_of`. */
export async function terminalStamp(db: PipelineDb): Promise<string | null> {
  const [row] = await db.select({ at: max(tables.sourceRuns.started_at) }).from(tables.sourceRuns)
  return row?.at ?? null
}

/**
 * The stamp read currently in flight, if any. Module scope, so it is per
 * isolate rather than per request — which is the point.
 */
let inFlightStamp: Promise<string | null> | null = null

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
export function sharedTerminalStamp(read: () => Promise<string | null>): Promise<string | null> {
  if (inFlightStamp) return inFlightStamp
  const tracked = read().finally(() => {
    if (inFlightStamp === tracked) inFlightStamp = null
  })
  inFlightStamp = tracked
  return tracked
}

export function terminalCacheKey(name: string, stamp: string | null): string {
  return `terminal:${name}:${stamp ?? 'never-polled'}`
}

/**
 * Serve `name` for the tick `stamp` from the store, computing and storing it
 * on a miss. `compute` runs at most once per (name, stamp) per five minutes
 * under normal conditions; under a failing store it runs every time, which
 * is slower and still correct.
 */
export async function cachedTerminal<T>(
  store: CacheStore,
  name: string,
  stamp: string | null,
  compute: () => Promise<T>,
): Promise<T> {
  const key = terminalCacheKey(name, stamp)
  try {
    const hit = await store.get(key)
    if (hit !== null && hit !== undefined) return hit as T
  } catch (error) {
    console.warn(JSON.stringify({ kind: 'terminal_cache_unavailable', name, error: String(error) }))
  }

  const value = await compute()

  try {
    await store.set(key, value, { ttl: TERMINAL_CACHE_TTL_SECONDS })
  } catch (error) {
    console.warn(
      JSON.stringify({ kind: 'terminal_cache_write_failed', name, error: String(error) }),
    )
  }
  return value
}
