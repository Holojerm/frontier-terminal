import { describe, expect, it } from 'vitest'

import {
  BODY_TOO_LARGE,
  FETCH_ATTEMPTS,
  MAX_BODY_BYTES,
  REDIRECT_REFUSED,
  SEC_CONTACT_UNSET,
  createFetcher,
  readCappedBody,
  userAgentFor,
} from '../../server/pipeline/fetch'
import type { FetchSource } from '../../server/pipeline/sources'

// The fetch stage with a scripted `fetch`: nothing here reaches the network.

const APP = { appUrl: 'https://frontier-terminal.example', secContactEmail: '' }
const WITH_EMAIL = { ...APP, secContactEmail: 'owner@example.com' }

const EDGAR: FetchSource = {
  source_id: 'edgar-fts',
  url: 'https://efts.sec.gov/LATEST/search-index?q=%22Anthropic%22&forms=S-1',
  ext: 'json',
}
const XAI: FetchSource = {
  source_id: 'xai-models-md',
  url: 'https://docs.x.ai/developers/models.md',
  ext: 'md',
}

/** A fetch that answers from a script and records what it was asked. */
function scripted(responses: (Response | Error)[]) {
  const calls: {
    url: string
    userAgent: string | null
    authorization: string | null
    redirect: RequestRedirect | undefined
    aborts: boolean
  }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      userAgent: new Headers(init?.headers).get('user-agent'),
      authorization: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
      // Every attempt must carry a deadline; the value is the platform's to keep.
      aborts: init?.signal instanceof AbortSignal,
    })
    const next = responses.shift()
    if (next === undefined) throw new Error('script exhausted')
    if (next instanceof Error) throw next
    return next
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const sleeps: number[] = []
const sleep = async (ms: number) => {
  sleeps.push(ms)
}

describe('userAgentFor', () => {
  it('names the project and its URL for ordinary hosts', () => {
    expect(userAgentFor(XAI.url, APP)).toBe(
      'Mozilla/5.0 (compatible; FrontierTerminal/1.0; +https://frontier-terminal.example)',
    )
  })

  it('uses the SEC contact form for sec.gov hosts, and refuses without an address', () => {
    expect(userAgentFor(EDGAR.url, WITH_EMAIL)).toBe('FrontierTerminal owner@example.com')
    expect(userAgentFor('https://data.sec.gov/submissions/CIK0001181412.json', APP)).toBeNull()
    expect(userAgentFor(EDGAR.url, { ...APP, secContactEmail: '   ' })).toBeNull()
  })
})

describe('createFetcher', () => {
  it('never fetches an SEC host anonymously', async () => {
    const { fetch, calls } = scripted([new Response('{}')])
    const outcome = await createFetcher({ ...APP, fetch, sleep })(EDGAR)
    expect(outcome).toEqual({ ok: false, status: null, detail: SEC_CONTACT_UNSET })
    expect(calls).toHaveLength(0)
  })

  it('sends the contact UA to SEC once configured', async () => {
    const { fetch, calls } = scripted([new Response('{"hits":{}}', { status: 200 })])
    const outcome = await createFetcher({ ...WITH_EMAIL, fetch, sleep })(EDGAR)
    expect(outcome).toMatchObject({ ok: true, status: 200, text: '{"hits":{}}', bytes: 11 })
    expect(calls).toMatchObject([
      { url: EDGAR.url, userAgent: 'FrontierTerminal owner@example.com', aborts: true },
    ])
  })

  it('retries a 5xx with backoff and returns the eventual body', async () => {
    sleeps.length = 0
    const { fetch, calls } = scripted([
      new Response('down', { status: 503 }),
      new Response('# models', { status: 200 }),
    ])
    const outcome = await createFetcher({ ...APP, fetch, sleep })(XAI)
    expect(outcome).toMatchObject({ ok: true, text: '# models' })
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([500])
  })

  it('does not retry a 4xx — that is the source’s answer', async () => {
    const { fetch, calls } = scripted([new Response('gone', { status: 404 })])
    const outcome = await createFetcher({ ...APP, fetch, sleep })(XAI)
    expect(outcome).toEqual({ ok: false, status: 404, detail: 'HTTP 404' })
    expect(calls).toHaveLength(1)
  })

  it('gives up after three attempts when fetch keeps throwing', async () => {
    sleeps.length = 0
    const { fetch, calls } = scripted([
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
    ])
    const outcome = await createFetcher({ ...APP, fetch, sleep })(XAI)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.detail).toBe('fetch threw: Error: ECONNRESET after 3 attempts')
    expect(calls).toHaveLength(FETCH_ATTEMPTS)
    expect(sleeps).toEqual([500, 2000])
  })

  it('counts bytes, not code units', async () => {
    const { fetch } = scripted([new Response('€')])
    const outcome = await createFetcher({ ...APP, fetch, sleep })(XAI)
    expect(outcome).toMatchObject({ ok: true, bytes: 3 })
  })

  it('gives every attempt a deadline, and follows redirects when nothing is at stake', async () => {
    const { fetch, calls } = scripted([new Response('# models')])
    await createFetcher({ ...APP, fetch, sleep })(XAI)
    expect(calls[0]).toMatchObject({ aborts: true, redirect: 'follow' })
  })
})

// The key is chosen from the URL we were handed. Following a redirect would
// hand it to whichever host answered — the fetch spec strips Authorization
// across origins, but a secret should not rest on someone else's invariant.
describe('createFetcher, credentialed', () => {
  const KEYED: FetchSource = {
    source_id: 'openrouter-rankings-daily',
    url: 'https://openrouter.ai/api/v1/datasets/rankings-daily',
    ext: 'json',
  }
  const WITH_KEY = { ...APP, openrouterApiKey: 'or-test-key' }

  it('refuses to chase a redirect, and never asks fetch to follow one', async () => {
    const { fetch, calls } = scripted([new Response('', { status: 302 })])
    const outcome = await createFetcher({ ...WITH_KEY, fetch, sleep })(KEYED)
    expect(outcome).toEqual({ ok: false, status: 302, detail: REDIRECT_REFUSED })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ redirect: 'manual', authorization: 'Bearer or-test-key' })
  })

  it('still serves a plain 200', async () => {
    const { fetch } = scripted([new Response('{"rankings":[]}')])
    const outcome = await createFetcher({ ...WITH_KEY, fetch, sleep })(KEYED)
    expect(outcome).toMatchObject({ ok: true, status: 200, text: '{"rankings":[]}' })
  })
})

describe('readCappedBody', () => {
  it('returns the body when it fits', async () => {
    expect(await readCappedBody(new Response('abc'), 3)).toEqual({ text: 'abc', bytes: 3 })
  })

  it('abandons a body that runs over the cap mid-stream', async () => {
    expect(await readCappedBody(new Response('abcdef'), 3)).toBeNull()
  })

  it('refuses on a declared content-length before reading anything', async () => {
    const response = new Response('short', {
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
    })
    expect(await readCappedBody(response, MAX_BODY_BYTES)).toBeNull()
    // Untouched: the refusal cost nothing.
    expect(response.bodyUsed).toBe(false)
  })

  it('reports the oversized source as a failed run, without retrying it', async () => {
    const { fetch, calls } = scripted([
      new Response('short', { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }),
    ])
    const outcome = await createFetcher({ ...APP, fetch, sleep })(XAI)
    expect(outcome).toEqual({ ok: false, status: 200, detail: BODY_TOO_LARGE })
    expect(calls).toHaveLength(1)
  })
})
