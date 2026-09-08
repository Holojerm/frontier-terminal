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

export const TERMINAL_CACHE_TTL_SECONDS = 300

/** The newest poll tick, or null before the first one. The cache key and every payload's `as_of`. */
export async function terminalStamp(db: PipelineDb): Promise<string | null> {
  const [row] = await db.select({ at: max(tables.sourceRuns.started_at) }).from(tables.sourceRuns)
  return row?.at ?? null
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
