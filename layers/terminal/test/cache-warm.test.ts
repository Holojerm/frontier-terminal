// The warm cron runs every five minutes, so its quiet tick must stay quiet,
// and a failure must leave the key cold enough to be retried.

import { describe, expect, it } from 'vitest'

import {
  WARM_LEASE_TTL_SECONDS,
  warmCaches,
  warmLeaseKey,
  warmMarkerKey,
  warmPaths,
  type WarmDeps,
} from '../server/utils/cache-warm'
import type { CacheStore } from '../server/utils/terminal-cache'

function deps(overrides: Partial<WarmDeps> = {}) {
  const map = new Map<string, unknown>()
  const rendered: string[] = []
  const store: CacheStore = {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value)
    },
  }
  const d: WarmDeps = {
    store,
    build: 'abc',
    stamp: async () => 's1',
    render: async (path) => {
      rendered.push(path)
      return 200
    },
    ...overrides,
  }
  return { d, map, rendered }
}

describe('warmCaches', () => {
  it('renders every path once, then does nothing until the stamp moves', async () => {
    const { d, rendered } = deps()
    const first = await warmCaches(d, ['/', '/prices', '/hiring', '/revenue'])
    expect(first).toMatchObject({ status: 'warmed', pages: 4, failed: [] })
    expect([...rendered].sort()).toEqual(['/', '/hiring', '/prices', '/revenue'])

    expect(await warmCaches(d, ['/'])).toEqual({ status: 'already-warm', stamp: 's1' })
    expect(rendered).toHaveLength(4)

    const moved = await warmCaches({ ...d, stamp: async () => 's2' }, ['/'])
    expect(moved.status).toBe('warmed')
    expect(rendered).toHaveLength(5)
  })

  it('goes again when a poll moves the stamp mid-warm', async () => {
    let stamp = 's1'
    const { d, rendered } = deps({
      stamp: async () => stamp,
      render: async (path) => {
        rendered.push(path)
        stamp = 's2'
        return 200
      },
    })
    const result = await warmCaches({ ...d, render: d.render }, ['/'])
    expect(result).toMatchObject({ status: 'warmed', stamp: 's2' })
    expect(rendered).toEqual(['/', '/'])
  })

  it('treats a new build as a new key', () => {
    expect(warmMarkerKey('a', 's1')).not.toBe(warmMarkerKey('b', 's1'))
    expect(warmMarkerKey('a', null)).toBe('cache-warm:a:never-polled')
  })

  it('leaves the marker unset when a page fails, so the next tick retries', async () => {
    const { d, map } = deps({
      render: async (path) => {
        if (path === '/hiring') throw new Error('d1 down')
        return path === '/prices' ? 503 : 200
      },
    })
    const result = await warmCaches(d, ['/', '/prices', '/hiring'])
    expect(result).toMatchObject({
      status: 'warmed',
      failed: expect.arrayContaining(['/prices', '/hiring']),
    })
    expect(map.has(warmMarkerKey('abc', 's1'))).toBe(false)
  })
})

describe('warmCaches backs off', () => {
  it('renders nothing while a poll holds the lock, and warms once it is free', async () => {
    let polling = true
    const { d, rendered } = deps({ pollRunning: async () => polling })
    expect(await warmCaches(d, ['/'])).toEqual({
      status: 'skipped',
      reason: 'poll-running',
      stamp: 's1',
    })
    expect(rendered).toEqual([])

    polling = false
    expect((await warmCaches(d, ['/'])).status).toBe('warmed')
  })

  it('leaves a (build, stamp) to whichever isolate claimed it first', async () => {
    const { d, map, rendered } = deps()
    map.set(warmLeaseKey('abc', 's1'), true)
    expect(await warmCaches(d, ['/'])).toEqual({ status: 'skipped', reason: 'leased', stamp: 's1' })
    expect(rendered).toEqual([])
  })

  it('claims the stamp before rendering, with a TTL that lapses before the next tick', async () => {
    const ttls = new Map<string, number | undefined>()
    const { d } = deps()
    const store: CacheStore = {
      get: d.store.get,
      set: async (key, value, opts) => {
        ttls.set(key, opts?.ttl)
        return d.store.set(key, value, opts)
      },
    }
    await warmCaches({ ...d, store }, ['/'])
    expect(ttls.get(warmLeaseKey('abc', 's1'))).toBe(WARM_LEASE_TTL_SECONDS)
    expect(WARM_LEASE_TTL_SECONDS).toBeGreaterThanOrEqual(60)
    expect(WARM_LEASE_TTL_SECONDS).toBeLessThan(300)
  })
})

describe('warmPaths', () => {
  it('dedupes and drops anything that is not a plain path', () => {
    expect(
      warmPaths([{ path: '/' }, { path: '/' }, { path: '/x?y=1' }, { path: 'https://a/b' }]),
    ).toEqual(['/'])
  })
})
