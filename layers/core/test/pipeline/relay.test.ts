import { describe, expect, it } from 'vitest'

import { createFetcher } from '../../server/utils/pipeline-fetch'
import {
  RELAY_MAX_AGE_MS,
  RELAY_PENDING,
  isRelayed,
  putRelayCopy,
  relayStore,
  wantedUrls,
} from '../../server/pipeline/relay'

const MISTRAL = 'https://status.mistral.ai/api/v2/incidents.json'
const APP = { appUrl: 'https://frontier-terminal.example', secContactEmail: '' }

/** R2 and KV as maps, with the methods the relay calls. */
function memory() {
  const objects = new Map<string, Uint8Array>()
  const keys = new Map<string, string>()
  const blob = {
    get: async (key: string) => {
      const b = objects.get(key)
      return b
        ? {
            arrayBuffer: async () => b.slice().buffer as ArrayBuffer,
            text: async () => new TextDecoder().decode(b),
          }
        : null
    },
    put: async (key: string, body: string | Uint8Array) => {
      objects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : body)
    },
  }
  const kv = {
    get: async (key: string) => keys.get(key) ?? null,
    set: async (key: string, value: string) => {
      keys.set(key, value)
    },
    keys: async (base = '') => [...keys.keys()].filter((k) => k.startsWith(base)),
  }
  return { blob, kv, store: relayStore(blob, kv) }
}

const never = (async () => {
  throw new Error('the network was called')
}) as typeof globalThis.fetch
const source = { source_id: 'mistral-status', url: MISTRAL, ext: 'json' }

describe('the relay', () => {
  it('covers only the hosts that refuse Workers', () => {
    expect(isRelayed(MISTRAL)).toBe(true)
    expect(isRelayed('https://www.ercot.com/committees/board')).toBe(true)
    expect(isRelayed('https://status.openai.com/api/v2/incidents.json')).toBe(false)
    expect(isRelayed('not a url')).toBe(false)
  })

  it('puts a URL on the job’s list and waits, without calling the network', async () => {
    const m = memory()
    const outcome = await createFetcher({ ...APP, fetch: never, relay: m.store })(source)
    expect(outcome).toEqual({ ok: false, status: null, detail: RELAY_PENDING, skipped: true })
    expect(await wantedUrls(m.kv)).toEqual([MISTRAL])
  })

  it('serves the job’s copy as the fetch', async () => {
    const m = memory()
    const body = new TextEncoder().encode('{"incidents":[]}')
    await putRelayCopy(m.blob, {
      url: MISTRAL,
      status: 200,
      fetched_at: new Date().toISOString(),
      body,
      contentType: 'application/json',
    })
    expect(await createFetcher({ ...APP, fetch: never, relay: m.store })(source)).toEqual({
      ok: true,
      status: 200,
      text: '{"incidents":[]}',
      bytes: body.byteLength,
    })
  })

  it('fails on an old copy or a refusal the mini got, so fleet sees it', async () => {
    const m = memory()
    const put = (status: number, ageMs: number) =>
      putRelayCopy(m.blob, {
        url: MISTRAL,
        status,
        fetched_at: new Date(Date.now() - ageMs).toISOString(),
        body: new Uint8Array(0),
        contentType: 'text/plain',
      })
    const fetcher = createFetcher({ ...APP, fetch: never, relay: m.store })
    await put(200, RELAY_MAX_AGE_MS + 60_000)
    expect(await fetcher(source)).toMatchObject({ ok: false, detail: /older than 6h/ })
    await put(429, 0)
    expect(await fetcher(source)).toMatchObject({ ok: false, status: 429, detail: /HTTP 429/ })
  })

  it('leaves other hosts on the network', async () => {
    const m = memory()
    const fetch = (async () => new Response('ok')) as typeof globalThis.fetch
    const outcome = await createFetcher({ ...APP, fetch, relay: m.store })({
      source_id: 'openai-status',
      url: 'https://status.openai.com/api/v2/incidents.json',
      ext: 'json',
    })
    expect(outcome).toMatchObject({ ok: true, text: 'ok' })
    expect(await wantedUrls(m.kv)).toEqual([])
  })
})
