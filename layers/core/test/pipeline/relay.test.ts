import { describe, expect, it } from 'vitest'

import {
  RELAY_MAX_AGE_MS,
  RELAY_PENDING,
  isRelayHost,
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
const OPENAI_PAGE = 'https://developers.openai.com/api/docs/models/gpt-5.5.md'
const openaiPage = { source_id: 'openai-model-md-gpt-5.5', url: OPENAI_PAGE, ext: 'md' }
const answering = (status: number, body = '') => {
  let calls = 0
  const fetch = (async () => {
    calls++
    return new Response(body, { status })
  }) as typeof globalThis.fetch
  return { fetch, calls: () => calls }
}

describe('the relay', () => {
  it('covers only the hosts that refuse Workers', () => {
    expect(isRelayed(MISTRAL)).toBe(true)
    expect(isRelayed('https://www.ercot.com/committees/board')).toBe(true)
    expect(isRelayed('https://www.customs.go.kr/streamdocs/v4/documents/1/texts')).toBe(true)
    expect(isRelayed('https://status.openai.com/api/v2/incidents.json')).toBe(false)
    expect(isRelayed('not a url')).toBe(false)
    expect(isRelayed(OPENAI_PAGE)).toBe(false)
    expect(isRelayHost(OPENAI_PAGE)).toBe(true)
    expect(isRelayHost('https://status.openai.com/api/v2/incidents.json')).toBe(false)
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

  describe('on a host relayed only when it refuses the Worker', () => {
    it('fetches directly and leaves the job’s list alone', async () => {
      const m = memory()
      const net = answering(200, '# GPT-5.5')
      const outcome = await createFetcher({ ...APP, fetch: net.fetch, relay: m.store })(openaiPage)
      expect(outcome).toMatchObject({ ok: true, text: '# GPT-5.5' })
      expect(net.calls()).toBe(1)
      expect(await wantedUrls(m.kv)).toEqual([])
    })

    it('keeps a 403 a refusal while the job has no copy, and asks it for one', async () => {
      const m = memory()
      const net = answering(403)
      const outcome = await createFetcher({ ...APP, fetch: net.fetch, relay: m.store })(openaiPage)
      expect(outcome).toEqual({ ok: false, status: 403, detail: `HTTP 403; ${RELAY_PENDING}` })
      expect(await wantedUrls(m.kv)).toEqual([OPENAI_PAGE])
    })

    it('serves the job’s copy once the host refuses again', async () => {
      const m = memory()
      const fetcher = createFetcher({ ...APP, fetch: answering(403).fetch, relay: m.store })
      await fetcher(openaiPage)
      await putRelayCopy(m.blob, {
        url: OPENAI_PAGE,
        status: 200,
        fetched_at: new Date().toISOString(),
        body: new TextEncoder().encode('# GPT-5.5'),
        contentType: 'text/markdown',
      })
      expect(await fetcher(openaiPage)).toMatchObject({ ok: true, status: 200, text: '# GPT-5.5' })
    })

    it('takes the URL off the job’s list when the host answers the Worker again', async () => {
      const m = memory()
      await createFetcher({ ...APP, fetch: answering(403).fetch, relay: m.store })(openaiPage)
      await putRelayCopy(m.blob, {
        url: OPENAI_PAGE,
        status: 200,
        fetched_at: new Date().toISOString(),
        body: new TextEncoder().encode('# old'),
        contentType: 'text/markdown',
      })
      const back = createFetcher({
        ...APP,
        fetch: answering(200, '# GPT-5.5').fetch,
        relay: m.store,
      })
      expect(await back(openaiPage)).toMatchObject({ ok: true, text: '# GPT-5.5' })
      expect(await wantedUrls(m.kv)).toEqual([])
      expect(m.objects.size).toBe(0)
    })

    it('passes any other failure through without asking the job', async () => {
      const m = memory()
      const outcome = await createFetcher({ ...APP, fetch: answering(404).fetch, relay: m.store })(
        openaiPage,
      )
      expect(outcome).toEqual({ ok: false, status: 404, detail: 'HTTP 404' })
      expect(await wantedUrls(m.kv)).toEqual([])
    })
  })
})
