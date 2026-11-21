import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import {
  GDELT_DISPATCH_FAILED_KIND,
  dispatchGdeltSearch,
  dispatchUrl,
} from '../server/pipeline/track-record/dispatch'
import { TERMINAL_OPS_SEVERITY } from '../server/utils/terminal-ops-severity'

const db = drizzle(env.DB, { schema })
const REPO = 'https://github.com/Holojerm/frontier-terminal'
const URL = dispatchUrl('Holojerm/frontier-terminal')

interface Sent {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(answer: () => Response | Promise<Response>) {
  const sent: Sent[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init })
    return answer()
  }) as typeof fetch
  return { fetcher, sent }
}

const events = async () =>
  (await db.select().from(schema.opsEvents)).filter((e) => e.kind === GDELT_DISPATCH_FAILED_KIND)

beforeEach(async () => {
  await db.delete(schema.opsEvents)
})

describe('dispatchGdeltSearch', () => {
  it('posts a workflow_dispatch on main with the token, and spools nothing on a 204', async () => {
    const { fetcher, sent } = fakeFetch(() => new Response(null, { status: 204 }))
    const result = await dispatchGdeltSearch(db, {
      fetch: fetcher,
      repoUrl: REPO,
      token: ' ghp-test ',
    })

    expect(result).toEqual({ status: 'dispatched' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(
      'https://api.github.com/repos/Holojerm/frontier-terminal/actions/workflows/gdelt-search.yml/dispatches',
    )
    expect(sent[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(sent[0]!.init?.body))).toEqual({ ref: 'main' })
    const headers = sent[0]!.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ghp-test')
    expect(headers['user-agent']).toMatch(/frontier-terminal/)
    expect(await events()).toHaveLength(0)
  })

  it('does nothing without a token, so the schedule alone runs the job', async () => {
    const { fetcher, sent } = fakeFetch(() => new Response(null, { status: 204 }))
    for (const token of [undefined, '', '  ']) {
      expect(await dispatchGdeltSearch(db, { fetch: fetcher, repoUrl: REPO, token })).toEqual({
        status: 'unconfigured',
      })
    }
    expect(sent).toHaveLength(0)
    expect(await events()).toHaveLength(0)
  })

  it('does nothing when fleet.json names no GitHub repo', async () => {
    const { fetcher, sent } = fakeFetch(() => new Response(null, { status: 204 }))
    expect(await dispatchGdeltSearch(db, { fetch: fetcher, repoUrl: '', token: 't' })).toEqual({
      status: 'no-repo',
    })
    expect(sent).toHaveLength(0)
  })

  it('spools a refusal with GitHub’s message, and never echoes the token', async () => {
    const { fetcher } = fakeFetch(() =>
      Response.json(
        { message: 'Resource not accessible by personal access token' },
        { status: 403 },
      ),
    )
    const result = await dispatchGdeltSearch(db, {
      fetch: fetcher,
      repoUrl: REPO,
      token: 'secret-token',
    })

    expect(result).toEqual({
      status: 'failed',
      detail: 'GitHub answered 403: Resource not accessible by personal access token',
    })
    const spooled = await events()
    expect(spooled.map((e) => e.detail)).toEqual([
      'gdelt-search.yml dispatch: GitHub answered 403: Resource not accessible by personal access token',
    ])
    expect(spooled[0]!.detail).not.toContain('secret-token')
  })

  it('spools a status with no JSON body, and a network error, without throwing', async () => {
    let answer: () => Response = () => new Response('bad gateway', { status: 502 })
    const { fetcher } = fakeFetch(() => answer())
    const deps = { fetch: fetcher, repoUrl: REPO, token: 't' }

    expect(await dispatchGdeltSearch(db, deps)).toEqual({
      status: 'failed',
      detail: 'GitHub answered 502',
    })
    answer = () => {
      throw new TypeError('network connection lost')
    }
    expect(await dispatchGdeltSearch(db, deps)).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('network connection lost'),
    })
    expect(await events()).toHaveLength(2)
  })

  it('gives its ops kind a tier, so the fleet reads it as a warning', () => {
    expect(TERMINAL_OPS_SEVERITY[GDELT_DISPATCH_FAILED_KIND]?.severity).toBe('warning')
    expect(URL).toContain('/actions/workflows/gdelt-search.yml/dispatches')
  })
})
