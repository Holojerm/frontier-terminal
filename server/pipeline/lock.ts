import type { Storage } from 'unstorage'

// Poll mutex. 6h is a multiple of 30m, so poll:edgar and poll:survey are due
// at the same instant every sixth hour; whichever wins the lock runs and the
// other skips its tick rather than double-writing. The TTL is the crash
// guard: a tick that dies holding the lock frees it within ten minutes.
//
// KV is eventually consistent, so this is a best-effort mutex, not a
// guarantee — two ticks starting within the same second could both see no
// lock. What makes that tolerable is the store: change and alert ids are
// deterministic, so the loser's writes collide on primary keys and surface
// as 'failed' runs rather than as duplicate rows.

export const POLL_LOCK_KEY = 'poll:lock'
export const POLL_LOCK_TTL_SECONDS = 600

/** The three KV operations the lock needs, so a test can hand in any store. */
export interface LockStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, ttlSeconds: number): Promise<void>
  delete(key: string): Promise<void>
}

/** Adapter over NuxtHub's unstorage `kv` handle (`import { kv } from '@nuxthub/kv'`). */
export function unstorageLockStore(kv: Storage): LockStore {
  return {
    get: async (key) => {
      const value = await kv.getItem(key)
      return typeof value === 'string' ? value : value === null ? null : String(value)
    },
    put: (key, value, ttl) => kv.setItem(key, value, { ttl }),
    delete: (key) => kv.removeItem(key),
  }
}

export type LockOutcome<T> = { skipped: true; heldBy: string } | { skipped: false; result: T }

/**
 * Run `fn` if nobody holds the poll lock; otherwise report who does and skip.
 * The lock is released when `fn` settles, success or throw, so the next tick
 * does not have to wait out the TTL.
 */
export async function withPollLock<T>(
  store: LockStore,
  holder: string,
  fn: () => Promise<T>,
): Promise<LockOutcome<T>> {
  const current = await store.get(POLL_LOCK_KEY)
  if (current !== null) return { skipped: true, heldBy: current }
  await store.put(POLL_LOCK_KEY, holder, POLL_LOCK_TTL_SECONDS)
  try {
    return { skipped: false, result: await fn() }
  } finally {
    await store.delete(POLL_LOCK_KEY)
  }
}
