import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { insertRows } from '../server/pipeline/store'
import {
  TERMINAL_CACHE_TTL_SECONDS,
  cachedTerminal,
  sharedTerminalStamp,
  terminalCacheKey,
  terminalStamp,
  type CacheStore,
} from '../server/utils/terminal-cache'

// The cache is keyed by the poll tick, so a poll invalidates it by
// construction; and it fails open, so a KV hiccup slows a page rather than
// breaking it.

const db = drizzle(env.DB, { schema })

function mapStore() {
  const map = new Map<string, unknown>()
  const ttls = new Map<string, number | undefined>()
  const store: CacheStore = {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value, opts) => {
      map.set(key, value)
      ttls.set(key, opts?.ttl)
    },
  }
  return { store, map, ttls }
}

beforeEach(async () => {
  await db.delete(schema.sourceRuns)
})

describe('terminalStamp', () => {
  it('is null before any poll and the newest started_at after', async () => {
    expect(await terminalStamp(db)).toBeNull()
    const run = (at: string) => ({
      id: `survey:x:${at}`,
      scope: 'survey',
      source_id: 'xai-models-md',
      started_at: at,
      status: 'ok',
      detail: null,
      snapshot_id: null,
      added: 0,
      removed: 0,
      modified: 0,
      source_url: 'https://docs.x.ai/developers/models.md',
    })
    await insertRows(db, 'source_runs', [
      run('2026-09-07T10:00:00.000Z'),
      run('2026-09-07T16:00:00.000Z'),
    ])
    expect(await terminalStamp(db)).toBe('2026-09-07T16:00:00.000Z')
  })
})

describe('cachedTerminal', () => {
  it('computes once per (name, tick) and serves the stored value after', async () => {
    const { store, map, ttls } = mapStore()
    let computed = 0
    const compute = async () => ({ n: ++computed })

    expect(await cachedTerminal(store, 'overview', 't1', compute)).toEqual({ n: 1 })
    expect(await cachedTerminal(store, 'overview', 't1', compute)).toEqual({ n: 1 })
    expect(computed).toBe(1)
    expect(map.has(terminalCacheKey('overview', 't1'))).toBe(true)
    expect(ttls.get(terminalCacheKey('overview', 't1'))).toBe(TERMINAL_CACHE_TTL_SECONDS)
  })

  it('a new tick is a miss, so a poll invalidates by construction', async () => {
    const { store } = mapStore()
    let computed = 0
    const compute = async () => ({ n: ++computed })
    await cachedTerminal(store, 'prices', 't1', compute)
    expect(await cachedTerminal(store, 'prices', 't2', compute)).toEqual({ n: 2 })
    // Different payloads under the same tick never share an entry.
    expect(await cachedTerminal(store, 'hiring', 't2', compute)).toEqual({ n: 3 })
    expect(terminalCacheKey('alerts', null)).toBe('terminal:alerts:never-polled')
  })

  it('fails open when the store throws, on read and on write', async () => {
    const broken: CacheStore = {
      get: async () => {
        throw new Error('kv down')
      },
      set: async () => {
        throw new Error('kv down')
      },
    }
    expect(await cachedTerminal(broken, 'overview', 't1', async () => 'fresh')).toBe('fresh')
  })
})

describe('sharedTerminalStamp', () => {
  // Rendering the front page fans out to eight endpoints that each need the
  // poll stamp. Sharing one in-flight read collapses eight identical D1
  // queries into one — and must not turn into a cache while doing it.

  it('collapses concurrent callers onto one read', async () => {
    let reads = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = async () => {
      reads += 1
      await gate
      return 't1'
    }

    const all = Promise.all(Array.from({ length: 8 }, () => sharedTerminalStamp(read)))
    release!()

    expect(await all).toEqual(Array.from({ length: 8 }, () => 't1'))
    expect(reads).toBe(1)
  })

  it('reads again once the previous read has settled, so it is not a cache', async () => {
    // The whole point: no TTL, no retained value, therefore no window in which
    // a stale stamp can be served. A caller that arrives after the last read
    // finished sees whatever D1 says now.
    const stamps = ['t1', 't2']
    let reads = 0
    const read = async () => stamps[reads++]!

    expect(await sharedTerminalStamp(read)).toBe('t1')
    expect(await sharedTerminalStamp(read)).toBe('t2')
    expect(reads).toBe(2)
  })

  it('shares a rejection, and still retries on the next call', async () => {
    // Eight fan-out calls should report one database outage, not eight. And a
    // failed read must not poison the slot — the next request tries again.
    let reads = 0
    const failing = async () => {
      reads += 1
      throw new Error('D1 unavailable')
    }

    const both = await Promise.allSettled([
      sharedTerminalStamp(failing),
      sharedTerminalStamp(failing),
    ])
    expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(reads).toBe(1)

    expect(await sharedTerminalStamp(async () => 't3')).toBe('t3')
  })

  it('reads the real stamp through the same path terminalPayload uses', async () => {
    await insertRows(db, 'source_runs', [
      {
        id: 'survey:openai:1',
        scope: 'survey',
        source_id: 'openai-pricing',
        started_at: '2026-09-22T10:00:00.000Z',
        status: 'ok',
        detail: null,
        snapshot_id: null,
        added: 0,
        removed: 0,
        modified: 0,
        source_url: 'https://openai.com/api/pricing/',
      },
    ])
    expect(await sharedTerminalStamp(() => terminalStamp(db))).toBe('2026-09-22T10:00:00.000Z')
  })
})
