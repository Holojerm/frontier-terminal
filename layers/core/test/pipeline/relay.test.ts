import { describe, expect, it } from 'vitest'

import {
  RELAY_MAX_AGE_MS,
  RELAY_PENDING,
  isRelayed,
  putRelayCopy,
  wantedUrls,
} from '../../server/pipeline/relay'
import { relayMemory as memory } from './relay-memory'

const MISTRAL = 'https://status.mistral.ai/api/v2/incidents.json'
const APP = { appUrl: 'https://frontier-terminal.example', secContactEmail: '' }

const never = (async () => {
  throw new Error('the network was called')
}) as typeof globalThis.fetch
const source = { source_id: 'mistral-status', url: MISTRAL, ext: 'json' }

describe('the relay', () => {
  it('covers only the hosts that refuse Workers', () => {
    expect(isRelayed(MISTRAL)).toBe(true)
    expect(isRelayed('https://www.ercot.com/committees/board')).toBe(true)
    expect(isRelayed('https://www.customs.go.kr/streamdocs/v4/documents/1/texts')).toBe(true)
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

  it('takes a URL that is done off the job’s list and drops its copy, so a later ask waits', async () => {
    const m = memory()
    const fetcher = createFetcher({ ...APP, fetch: never, relay: m.store })
    await fetcher(source)
    await putRelayCopy(m.blob, {
      url: MISTRAL,
      status: 200,
      fetched_at: new Date(Date.now() - RELAY_MAX_AGE_MS - 60_000).toISOString(),
      body: new TextEncoder().encode('{}'),
      contentType: 'application/json',
    })
    await m.store.done([MISTRAL])
    expect(await wantedUrls(m.kv)).toEqual([])
    expect(m.objects.size).toBe(0)
    // Not the old copy's "older than 6h": there is none.
    expect(await fetcher(source)).toMatchObject({ detail: RELAY_PENDING, skipped: true })
    expect(await wantedUrls(m.kv)).toEqual([MISTRAL])
  })

  it('writes a URL’s list entry once a day, not on every ask', async () => {
    const m = memory()
    await m.store.want(MISTRAL)
    const [key] = [...m.keys.keys()]
    const first = m.keys.get(key!)
    await m.store.want(MISTRAL)
    expect(m.keys.get(key!)).toBe(first)

    const old = new Date(Date.now() - 25 * 3_600_000).toISOString()
    m.keys.set(key!, JSON.stringify({ url: MISTRAL, asked_at: old }))
    await m.store.want(MISTRAL)
    expect(m.keys.get(key!)).not.toContain(old)

    // An entry from before entries carried their time: listed, then rewritten.
    m.keys.set(key!, JSON.stringify(MISTRAL))
    expect(await wantedUrls(m.kv)).toEqual([MISTRAL])
    await m.store.want(MISTRAL)
    expect(JSON.parse(m.keys.get(key!)!)).toMatchObject({ url: MISTRAL })
    expect(await wantedUrls(m.kv)).toEqual([MISTRAL])
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
