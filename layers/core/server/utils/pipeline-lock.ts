import type { Storage } from 'unstorage'

// Poll mutex shared by poll:edgar and poll:survey. poll.ts decides the shared :00 slot
// (edgar yields), so this only handles overruns, stale keys and KV lag. The 10-minute
// TTL frees a lock a crashed tick held.
//
// KV is eventually consistent, so two ticks can both acquire. Deterministic change and
// alert ids inserted skip-existing (store.ts › applyDiff) make the loser's writes no-ops.
//
// The value carries a per-acquisition token and release deletes only while it matches,
// so a tick that outran the TTL can't delete a later holder's lock.

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
 * apart. The lock is released when `fn` settles, so the next tick doesn't wait
 * out the TTL.
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
  if (current !== null) return { skipped: true, heldBy: holderOf(current) }
  const value = `${holder}${TOKEN_SEPARATOR}${crypto.randomUUID()}`
  await store.put(POLL_LOCK_KEY, value, POLL_LOCK_TTL_SECONDS)
  try {
    return { skipped: false, result: await fn() }
  } finally {
    // KV has no compare-and-delete, so a holder could still slip in between
    // this read and the delete; the window is one round trip, not the TTL.
    if ((await store.get(POLL_LOCK_KEY)) === value) await store.delete(POLL_LOCK_KEY)
  }
}

const TOKEN_SEPARATOR = ' #'

/** The holder named in a lock value, without the acquisition token. */
function holderOf(value: string): string {
  const at = value.lastIndexOf(TOKEN_SEPARATOR)
  return at === -1 ? value : value.slice(0, at)
}
