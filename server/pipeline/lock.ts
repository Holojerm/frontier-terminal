import type { Storage } from 'unstorage'

// Poll mutex. Two crons share it: poll:edgar (*/30) and poll:survey (0 */6),
// and 6h is a multiple of 30m, so both are due at the same instant every
// sixth hour. The policy for that instant is decided before the lock is
// touched, in server/pipeline/poll.ts: edgar yields, because the survey
// re-fetches EDGAR anyway, so the survey is the only tick that asks for the
// lock at :00 of a sixth hour. Here the lock only has to handle the residue —
// a survey that overruns into the next edgar tick, a stale key left by a
// crashed tick, or KV's eventual consistency showing a holder that has
// already gone. A caller may retry acquisition for those cases; the survey
// does (a stale key has at most the TTL to live), edgar does not (its next
// tick is thirty minutes away). The TTL is the crash guard: a tick that dies
// holding the lock frees it within ten minutes.
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

/** How many more times to look for a free lock, and how long to wait between looks. */
export interface LockRetry {
  retries: number
  delayMs: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run `fn` if nobody holds the poll lock; otherwise report who does and skip.
 * With `retry`, a held lock is re-checked up to `retries` more times, `delayMs`
 * apart, before giving up. The lock is released when `fn` settles, success or
 * throw, so the next tick does not have to wait out the TTL.
 */
export async function withPollLock<T>(
  store: LockStore,
  holder: string,
  fn: () => Promise<T>,
  retry: LockRetry = { retries: 0, delayMs: 0 },
): Promise<LockOutcome<T>> {
  let current = await store.get(POLL_LOCK_KEY)
  for (let attempt = 0; current !== null && attempt < retry.retries; attempt++) {
    await sleep(retry.delayMs)
    current = await store.get(POLL_LOCK_KEY)
  }
  if (current !== null) return { skipped: true, heldBy: current }
  await store.put(POLL_LOCK_KEY, holder, POLL_LOCK_TTL_SECONDS)
  try {
    return { skipped: false, result: await fn() }
  } finally {
    await store.delete(POLL_LOCK_KEY)
  }
}
