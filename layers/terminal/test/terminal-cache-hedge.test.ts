// A cold KV read is slower than the recompute it caches, so past KV_HEDGE_MS
// the reader gets whichever finishes first. These pin each branch of that race.

import { describe, expect, it } from 'vitest'

import type { ServerTiming } from '../server/utils/server-timing'
import { cachedTerminal, terminalCacheKey, type CacheStore } from '../server/utils/terminal-cache'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function slowStore(initial: Record<string, unknown>, readMs: number) {
  const map = new Map(Object.entries(initial))
  const writes: string[] = []
  const store: CacheStore = {
    get: async (key) => {
      await wait(readMs)
      return map.get(key) ?? null
    },
    set: async (key, value) => {
      writes.push(key)
      map.set(key, value)
    },
  }
  return { store, writes }
}

const KEY = terminalCacheKey('prices', 's1')

async function run(store: CacheStore, compute: () => Promise<string>) {
  const timings: ServerTiming[] = []
  const deferred: Promise<unknown>[] = []
  const value = await cachedTerminal(store, 'prices', 's1', compute, {
    timings,
    defer: (p) => deferred.push(p),
    hedgeMs: 5,
  })
  await Promise.all(deferred)
  return { value, kv: timings.find((t) => t.name === 'kv')?.desc }
}

describe('hedged KV read', () => {
  it('serves a fast hit without computing', async () => {
    const { store } = slowStore({ [KEY]: 'cached' }, 0)
    let computed = false
    const result = await run(store, async () => {
      computed = true
      return 'fresh'
    })
    expect(result).toEqual({ value: 'cached', kv: 'hit' })
    expect(computed).toBe(false)
  })

  it('serves the recompute when it beats a slow hit, and does not rewrite the key', async () => {
    const { store, writes } = slowStore({ [KEY]: 'cached' }, 60)
    const result = await run(store, async () => 'fresh')
    expect(result).toEqual({ value: 'fresh', kv: 'slow' })
    expect(writes).toEqual([])
  })

  it('serves a slow hit when the recompute is slower still', async () => {
    const { store } = slowStore({ [KEY]: 'cached' }, 20)
    const result = await run(store, async () => {
      await wait(80)
      return 'fresh'
    })
    expect(result).toEqual({ value: 'cached', kv: 'slow-hit' })
  })

  it('falls back to a slow hit when the recompute fails', async () => {
    const { store } = slowStore({ [KEY]: 'cached' }, 30)
    const result = await run(store, async () => {
      throw new Error('d1 down')
    })
    expect(result.value).toBe('cached')
  })

  it('writes the recompute when the slow read comes back empty', async () => {
    const { store, writes } = slowStore({}, 30)
    const result = await run(store, async () => {
      await wait(60)
      return 'fresh'
    })
    expect(result).toEqual({ value: 'fresh', kv: 'slow' })
    expect(writes).toEqual([KEY])
  })

  it('throws the recompute error when there is nothing cached either', async () => {
    const { store } = slowStore({}, 30)
    await expect(
      run(store, async () => {
        throw new Error('d1 down')
      }),
    ).rejects.toThrow('d1 down')
  })
})
