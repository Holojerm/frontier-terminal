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

  it('writes the holder under the lock key with the crash-guard TTL', async () => {
    expect(POLL_LOCK_TTL_SECONDS).toBe(600)
    await withPollLock(store, 'survey@t3', async () => {
      const { metadata: _m, ...entry } = (await env.KV.getWithMetadata(POLL_LOCK_KEY)) ?? {}
      expect(entry.value).toBe('survey@t3')
    })
  })
})
