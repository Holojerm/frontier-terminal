import { env } from 'cloudflare:test'
import { createStorage } from 'unstorage'
import cloudflareKvBinding from 'unstorage/drivers/cloudflare-kv-binding'
import { describe, expect, it } from 'vitest'

import {
  POLL_LOCK_KEY,
  POLL_LOCK_TTL_SECONDS,
  unstorageLockStore,
  withPollLock,
} from '../../server/pipeline/lock'

// The poll mutex, through the same unstorage driver NuxtHub's `kv` uses in
// production, over the real KV binding.

const store = unstorageLockStore(
  createStorage({ driver: cloudflareKvBinding({ binding: env.KV }) }),
)

describe('withPollLock', () => {
  it('runs when free, and an overlapping tick skips instead of running twice', async () => {
    let inner: unknown = null
    const first = await withPollLock(store, 'survey@t0', async () => {
      inner = await withPollLock(store, 'edgar@t0', async () => 'should not run')
      return 'ran'
    })
    expect(first).toEqual({ skipped: false, result: 'ran' })
    expect(inner).toEqual({ skipped: true, heldBy: 'survey@t0' })
  })

  it('releases the lock when the tick finishes, even by throwing', async () => {
    await expect(
      withPollLock(store, 'edgar@t1', async () => {
        throw new Error('D1 exploded')
      }),
    ).rejects.toThrow('D1 exploded')
    expect(await env.KV.get(POLL_LOCK_KEY)).toBeNull()

    const next = await withPollLock(store, 'edgar@t2', async () => 'ok')
    expect(next).toEqual({ skipped: false, result: 'ok' })
  })

  it('with retries, waits out a holder that lets go and then runs', async () => {
    await env.KV.put(POLL_LOCK_KEY, 'edgar@stale')
    setTimeout(() => env.KV.delete(POLL_LOCK_KEY), 30)
    const outcome = await withPollLock(store, 'survey@t4', async () => 'ran', {
      retries: 10,
      delayMs: 10,
    })
    expect(outcome).toEqual({ skipped: false, result: 'ran' })
    expect(await env.KV.get(POLL_LOCK_KEY)).toBeNull()
  })

  it('with retries exhausted, skips and names the holder', async () => {
    await env.KV.put(POLL_LOCK_KEY, 'edgar@stuck')
    let calls = 0
    const outcome = await withPollLock(
      store,
      'survey@t5',
      async () => {
        calls++
        return 'should not run'
      },
      { retries: 2, delayMs: 5 },
    )
    expect(outcome).toEqual({ skipped: true, heldBy: 'edgar@stuck' })
    expect(calls).toBe(0)
    await env.KV.delete(POLL_LOCK_KEY)
  })

  it('without retries, a held lock is a skip on the first look', async () => {
    await env.KV.put(POLL_LOCK_KEY, 'survey@long')
    const looks: string[] = []
    const counting = {
      ...store,
      get: async (key: string) => {
        looks.push(key)
        return store.get(key)
      },
    }
    const outcome = await withPollLock(counting, 'edgar@t6', async () => 'should not run')
    expect(outcome).toEqual({ skipped: true, heldBy: 'survey@long' })
    expect(looks).toEqual([POLL_LOCK_KEY])
    await env.KV.delete(POLL_LOCK_KEY)
  })

  it('writes the holder under the lock key with the crash-guard TTL', async () => {
    expect(POLL_LOCK_TTL_SECONDS).toBe(600)
    await withPollLock(store, 'survey@t3', async () => {
      const { metadata: _m, ...entry } = (await env.KV.getWithMetadata(POLL_LOCK_KEY)) ?? {}
      expect(entry.value).toBe('survey@t3')
    })
  })
})
