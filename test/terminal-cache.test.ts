import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { insertRows } from '../server/pipeline/store'
import {
  TERMINAL_CACHE_TTL_SECONDS,
  cachedTerminal,
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
