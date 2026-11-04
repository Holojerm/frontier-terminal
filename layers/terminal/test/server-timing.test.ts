// Server-Timing is how `bun run perf` attributes a slow first load to a stage,
// so the stages a cache miss and a cache hit report must differ.

import { describe, expect, it } from 'vitest'

import { serverTimingHeader, timed, type ServerTiming } from '../server/utils/server-timing'
import { cachedTerminal, type CacheStore } from '../server/utils/terminal-cache'

function mapStore(): CacheStore {
  const map = new Map<string, unknown>()
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value)
    },
  }
}

describe('serverTimingHeader', () => {
  it('formats durations as whole milliseconds with an optional description', () => {
    expect(
      serverTimingHeader([
        { name: 'stamp', dur: 12.6 },
        { name: 'kv', dur: 80, desc: 'miss' },
      ]),
    ).toBe('stamp;dur=13, kv;dur=80;desc="miss"')
  })

  it('strips characters that would break out of the quoted description', () => {
    expect(serverTimingHeader([{ name: 'kv', dur: 1, desc: 'a"b\\c' }])).toBe('kv;dur=1;desc="abc"')
  })
})

describe('timed', () => {
  it('records the stage even when it throws', async () => {
    const timings: ServerTiming[] = []
    await expect(
      timed(timings, 'stamp', async () => {
        throw new Error('down')
      }),
    ).rejects.toThrow('down')
    expect(timings.map((t) => t.name)).toEqual(['stamp'])
  })

  it('is a pass-through when nobody is timing', async () => {
    expect(await timed(undefined, 'stamp', async () => 7)).toBe(7)
  })
})

describe('cachedTerminal timings', () => {
  it('reports kv miss, compute and the write on a miss; kv hit alone on a hit', async () => {
    const store = mapStore()
    const miss: ServerTiming[] = []
    await cachedTerminal(store, 'prices', 's1', async () => ({ rows: 1 }), { timings: miss })
    expect(miss.map((t) => [t.name, t.desc])).toEqual([
      ['kv', 'miss'],
      ['compute', undefined],
      ['kv-put', undefined],
    ])

    const hit: ServerTiming[] = []
    await cachedTerminal(store, 'prices', 's1', async () => ({ rows: 2 }), { timings: hit })
    expect(hit.map((t) => [t.name, t.desc])).toEqual([['kv', 'hit']])
  })

  it('hands the write to defer instead of awaiting it, and the entry still lands', async () => {
    const store = mapStore()
    const deferred: Promise<unknown>[] = []
    const timings: ServerTiming[] = []
    const value = await cachedTerminal(store, 'prices', 's1', async () => 'fresh', {
      timings,
      defer: (p) => deferred.push(p),
    })
    expect(value).toBe('fresh')
    expect(timings.map((t) => t.name)).toEqual(['kv', 'compute'])
    expect(deferred).toHaveLength(1)
    await Promise.all(deferred)
    expect(await cachedTerminal(store, 'prices', 's1', async () => 'recomputed')).toBe('fresh')
  })
})
