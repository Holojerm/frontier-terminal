import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../../server/db/schema'
import { contentHash } from '../../server/pipeline/contracts'
import {
  OPENROUTER_KEY_UNSET,
  createFetcher,
  needsOpenRouterKey,
  type FetchOutcome,
  type SourceFetcher,
} from '../../server/pipeline/fetch'
import { pendingChanges } from '../../server/pipeline/judge/pending'
import { asOfFromDetail } from '../../server/pipeline/lanes'
import { providerOfOpenRouterId } from '../../server/pipeline/parsers/openrouter'
import { parseOpenRouterRankings } from '../../server/pipeline/parsers/openrouter-rankings'
import {
  SKIPPED_EVENT_INTERVAL_MS,
  runRefresh,
  type RawStore,
  type RefreshDeps,
} from '../../server/pipeline/refresh'
import { includeSources } from '../../server/pipeline/sources'
import { queryMovement } from '../../server/utils/terminal-db'
import { fixtureText, manifest, provenanceOf } from './fixtures'

// The demand-share source end to end: the parser against the CONSTRUCTED
// fixture (documented schema, not observed bytes — fixtures/manifest.json),
// the keyed fetch, the honest 'skipped' path without the key, and the two
// places ranking rows are kept away from the judge and the signal band.

const SOURCE_ID = 'openrouter-rankings-daily'
const FIXTURE = 'fixtures/rankings/openrouter-rankings-daily.json'
const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const ALL = includeSources(sourcesYaml, manifest.fixtures)
const urlOf = (id: string) => ALL.find((s) => s.source_id === id)!.url

describe('parseOpenRouterRankings on the constructed fixture', () => {
  const out = parseOpenRouterRankings(fixtureText(FIXTURE))

  it('yields one validated row per (date, model) with total_tokens as a number', () => {
    expect(out.rows).toHaveLength(24)
    expect(out.as_of).toBe('2026-09-07T02:00:00.000Z')
    const sonnet = out.rows.find(
      (r) => r.date === '2026-09-06' && r.model_permaslug === 'anthropic/claude-sonnet-4.5',
    )!
    expect(sonnet).toMatchObject({ provider: 'anthropic', total_tokens: 980_000_000_000 })
    expect(typeof sonnet.total_tokens).toBe('number')
  })

  it('carries the provenance the manifest records — the documentation, since nothing was fetched', () => {
    const prov = provenanceOf(SOURCE_ID)
    expect(prov.source_url).toBe('https://openrouter.ai/docs/cookbook/administration/data-api')
    for (const row of out.rows) expect(row).toMatchObject(prov)
    const entry = manifest.fixtures.find((f) => f.source_id === SOURCE_ID)!
    expect('fetched_at' in entry).toBe(false)
    expect(entry).toHaveProperty('constructed')
  })

  it('is ordered by date then permaslug, whatever order the payload used', () => {
    const keys = out.rows.map((r) => `${r.date} ${r.model_permaslug}`)
    expect(keys).toEqual([...keys].sort())
    const shuffled = JSON.parse(fixtureText(FIXTURE)) as { data: unknown[] }
    shuffled.data.reverse()
    expect(contentHash(parseOpenRouterRankings(JSON.stringify(shuffled)))).toBe(contentHash(out))
  })

  it('maps permaslug prefixes to labs and everything else, the aggregate row included, to other', () => {
    expect(providerOfOpenRouterId('openai/gpt-5.2')).toBe('openai')
    expect(providerOfOpenRouterId('anthropic/claude-opus-4.5')).toBe('anthropic')
    expect(providerOfOpenRouterId('google/gemini-3-pro')).toBe('google')
    expect(providerOfOpenRouterId('x-ai/grok-4.6')).toBe('xai')
    expect(providerOfOpenRouterId('deepseek/deepseek-v4')).toBe('other')
    expect(providerOfOpenRouterId('other')).toBe('other')
    expect(providerOfOpenRouterId('')).toBe('other')
    const byProvider = new Map<string, number>()
    for (const r of out.rows) byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + 1)
    expect(Object.fromEntries(byProvider)).toEqual({
      other: 6,
      anthropic: 6,
      openai: 6,
      google: 3,
      xai: 3,
    })
  })

  it('refuses a total_tokens that is not a non-negative integer, and a payload with no data', () => {
    const doc = JSON.parse(fixtureText(FIXTURE)) as { data: { total_tokens: unknown }[] }
    doc.data[0]!.total_tokens = '12.5'
    expect(() => parseOpenRouterRankings(JSON.stringify(doc))).toThrow(
      'data[0].total_tokens is not a non-negative integer: "12.5"',
    )
    doc.data[0]!.total_tokens = -1
    expect(() => parseOpenRouterRankings(JSON.stringify(doc))).toThrow('data[0].total_tokens')
    expect(() => parseOpenRouterRankings('{"meta":{}}')).toThrow('no data array')
    // A malformed date or as_of is a schema failure, not a silent row.
    expect(() =>
      parseOpenRouterRankings(
        JSON.stringify({
          data: [{ date: '2026-9-6', model_permaslug: 'x', total_tokens: '1' }],
          meta: { as_of: 'today' },
        }),
      ),
    ).toThrow()
  })

  it('as_of round-trips through the run detail the lane writes', () => {
    expect(asOfFromDetail('24 entities; as_of 2026-09-07T02:00:00.000Z')).toBe(
      '2026-09-07T02:00:00.000Z',
    )
    expect(asOfFromDetail(null)).toBeNull()
    expect(asOfFromDetail('no parser')).toBeNull()
  })
})

describe('the keyed fetch', () => {
  const APP = { appUrl: 'https://frontier-terminal.example', secContactEmail: '' }
  const RANKINGS = ALL.find((s) => s.source_id === SOURCE_ID)!
  const MODELS = ALL.find((s) => s.source_id === 'openrouter-models')!

  function scripted() {
    const calls: { url: string; authorization: string | null }[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return new Response('{"data":[],"meta":{}}', { status: 200 })
    }) as typeof globalThis.fetch
    return { fetch, calls }
  }

  it('only the datasets endpoint needs the key', () => {
    expect(needsOpenRouterKey(RANKINGS.url)).toBe(true)
    expect(needsOpenRouterKey(MODELS.url)).toBe(false)
    expect(needsOpenRouterKey('https://openrouter.ai/rankings')).toBe(false)
  })

  it('is skipped, not fetched, without the key', async () => {
    const { fetch, calls } = scripted()
    const outcome = await createFetcher({ ...APP, fetch, sleep: async () => {} })(RANKINGS)
    expect(outcome).toEqual({
      ok: false,
      status: null,
      detail: OPENROUTER_KEY_UNSET,
      skipped: true,
    })
    expect(calls).toHaveLength(0)
  })

  it('sends the key as a bearer to the datasets endpoint and nowhere else', async () => {
    const { fetch, calls } = scripted()
    const fetcher = createFetcher({
      ...APP,
      openrouterApiKey: ' k-test ',
      fetch,
      sleep: async () => {},
    })
    expect((await fetcher(RANKINGS)).ok).toBe(true)
    expect((await fetcher(MODELS)).ok).toBe(true)
    expect(calls).toEqual([
      { url: RANKINGS.url, authorization: 'Bearer k-test' },
      { url: MODELS.url, authorization: null },
    ])
  })
})

// ── the refresh, against the real D1 ────────────────────────────────────────

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}
let tick = Date.parse('2026-09-07T10:00:00Z')
const now = () => new Date((tick += 1000))
const deps = (fetcher: SourceFetcher, clock = now): RefreshDeps => ({
  db,
  raw,
  fetcher,
  sourcesYaml,
  now: clock,
})
const SKIPPED: FetchOutcome = {
  ok: false,
  status: null,
  detail: OPENROUTER_KEY_UNSET,
  skipped: true,
}
const skippedFetcher: SourceFetcher = async () => SKIPPED
const fixtureFetcher =
  (text = fixtureText(FIXTURE)): SourceFetcher =>
  async (source) => {
    if (source.source_id !== SOURCE_ID) throw new Error(`unexpected fetch of ${source.source_id}`)
    return { ok: true, status: 200, text, bytes: text.length }
  }
const opsKinds = async () => (await db.select().from(schema.opsEvents)).map((o) => o.kind)

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
    schema.alerts,
    schema.changes,
    schema.entities,
    schema.snapshots,
    schema.opsEvents,
  ]) {
    await db.delete(table)
  }
})

describe('without the key', () => {
  it('records a skipped run — not a failure — and one ops event, not one per tick', async () => {
    const first = await runRefresh(deps(skippedFetcher), 'survey', [SOURCE_ID])
    expect(first.sources).toEqual([
      {
        source_id: SOURCE_ID,
        status: 'skipped',
        detail: OPENROUTER_KEY_UNSET,
        snapshot_id: null,
        added: 0,
        removed: 0,
        modified: 0,
        alerts: 0,
      },
    ])
    expect(first.failed).toBe(0)
    expect(first.all_failed).toBe(false)
    expect(await db.select().from(schema.snapshots)).toHaveLength(0)
    const [run] = await db.select().from(schema.sourceRuns)
    expect(run).toMatchObject({ status: 'skipped', source_url: urlOf(SOURCE_ID) })
    expect(await opsKinds()).toEqual(['source_unconfigured'])

    // Three more ticks the same day: still one event.
    for (let i = 0; i < 3; i++) await runRefresh(deps(skippedFetcher), 'survey', [SOURCE_ID])
    expect(await db.select().from(schema.sourceRuns)).toHaveLength(4)
    expect(await opsKinds()).toEqual(['source_unconfigured'])

    // The next day it is said again — once.
    let later = tick + SKIPPED_EVENT_INTERVAL_MS
    const nextDay = () => new Date((later += 1000))
    await runRefresh(deps(skippedFetcher, nextDay), 'survey', [SOURCE_ID])
    await runRefresh(deps(skippedFetcher, nextDay), 'survey', [SOURCE_ID])
    expect(await opsKinds()).toEqual(['source_unconfigured', 'source_unconfigured'])
  })

  it('does not make a tick "all failed" when every other source succeeded or was skipped', async () => {
    const report = await runRefresh(deps(skippedFetcher), 'survey', [SOURCE_ID])
    expect(report.all_failed).toBe(false)
    expect(await opsKinds()).not.toContain('all_sources_failed')
  })
})

describe('with the key', () => {
  it('baselines ranking entities, carries as_of on the run, and a revision is one modified row', async () => {
    const baseline = await runRefresh(deps(fixtureFetcher()), 'survey', [SOURCE_ID])
    expect(baseline.sources[0]).toMatchObject({
      status: 'baseline',
      detail: '24 entities; as_of 2026-09-07T02:00:00.000Z',
    })
    const entities = await db.select().from(schema.entities)
    expect(entities).toHaveLength(24)
    for (const e of entities) {
      expect(e.entity_type).toBe('ranking')
      expect(e.source_url).toBe(urlOf(SOURCE_ID))
      expect(e.entity_key).toMatch(/^ranking:\d{4}-\d{2}-\d{2}:/)
      expect(contentHash(JSON.parse(e.payload))).toBe(e.content_hash)
    }
    expect(entities.find((e) => e.entity_key === 'ranking:2026-09-05:x-ai/grok-4.6')).toMatchObject(
      {
        provider: 'xai',
      },
    )

    // A day scrolling out of the window is not un-observed: nothing is removed.
    const doc = JSON.parse(fixtureText(FIXTURE)) as {
      data: { date: string; model_permaslug: string; total_tokens: string }[]
      meta: { as_of: string }
    }
    const revised = {
      data: doc.data
        .filter((r) => r.date !== '2026-09-04')
        .map((r) =>
          r.date === '2026-09-06' && r.model_permaslug === 'x-ai/grok-4.6'
            ? { ...r, total_tokens: '200000000000' }
            : r,
        ),
      meta: { ...doc.meta, as_of: '2026-09-08T02:00:00.000Z' },
    }
    const second = await runRefresh(deps(fixtureFetcher(JSON.stringify(revised))), 'survey', [
      SOURCE_ID,
    ])
    expect(second.sources[0]).toMatchObject({
      status: 'ok',
      added: 0,
      removed: 0,
      modified: 1,
      detail: 'as_of 2026-09-08T02:00:00.000Z',
    })
    expect(await db.select().from(schema.entities)).toHaveLength(24)
    const [change] = await db.select().from(schema.changes)
    expect(change).toMatchObject({
      entity_type: 'ranking',
      entity_key: 'ranking:2026-09-06:x-ai/grok-4.6',
      change_type: 'modified',
    })
    expect(JSON.parse(change!.after_json!).total_tokens).toBe(200_000_000_000)
  })

  it('keeps ranking changes away from the judge and out of the signal band', async () => {
    await runRefresh(deps(fixtureFetcher()), 'survey', [SOURCE_ID])
    const doc = JSON.parse(fixtureText(FIXTURE)) as { data: { total_tokens: string }[] }
    doc.data[1]!.total_tokens = '1'
    await runRefresh(deps(fixtureFetcher(JSON.stringify(doc))), 'survey', [SOURCE_ID])
    expect(await db.select().from(schema.changes)).toHaveLength(1)

    const pending = await pendingChanges(db)
    expect(pending).toEqual({ changes: [], total_pending: 0, since: null })

    const movement = await queryMovement(db)
    expect(movement.total_changes).toBe(0)
    expect(movement.latest_detected_at).toBeNull()
    expect(movement.recent.total).toBe(0)
  })
})
