import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../../server/db/schema'
import { contentHash, type PollScope } from '../../server/pipeline/contracts'
import type { FetchOutcome, SourceFetcher } from '../../server/pipeline/fetch'
import { runRefresh, type RawStore, type RefreshDeps } from '../../server/pipeline/refresh'
import { sourceIdsForScope } from '../../server/pipeline/scopes'
import { includeSources } from '../../server/pipeline/sources'
import { collectFleetCounters, latestFetchBySource } from '../../server/utils/fleet-status'
import { fixtureText, manifest } from './fixtures'

// The refresh end-to-end against the real D1 and R2 test bindings, driven by
// a fetcher that serves the committed fixtures (edited in place for the
// change scenarios). No network anywhere in this file.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const ALL = includeSources(sourcesYaml, manifest.fixtures)
const ALL_IDS = ALL.map((s) => s.source_id)
const urlOf = (id: string) => ALL.find((s) => s.source_id === id)!.url

/** Fixture bytes by source id, with per-test overrides (text or a failed outcome). */
function fixtureFetcher(overrides: Record<string, string | FetchOutcome> = {}): SourceFetcher {
  const byUrl = new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))
  return async (source) => {
    const override = overrides[source.source_id]
    if (override !== undefined && typeof override !== 'string') return override
    const text = override ?? byUrl.get(source.url)
    if (text === undefined) throw new Error(`no fixture for ${source.url}`)
    return { ok: true, status: 200, text, bytes: text.length }
  }
}

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}
const rawKeys = async () => (await env.BLOB.list({ prefix: 'raw/' })).objects.map((o) => o.key)

// A clock that advances one second per read, so every snapshot id is unique
// and every fetched_at is a value the test chose.
let tick = Date.parse('2026-09-07T10:00:00Z')
const now = () => new Date((tick += 1000))

function deps(fetcher: SourceFetcher): RefreshDeps {
  return { db, raw, fetcher, sourcesYaml, now }
}

const run = (scope: PollScope, ids: readonly string[], fetcher = fixtureFetcher()) =>
  runRefresh(deps(fetcher), scope, ids)

const rows = {
  snapshots: () => db.select().from(schema.snapshots),
  entities: () => db.select().from(schema.entities),
  changes: () => db.select().from(schema.changes),
  alerts: () => db.select().from(schema.alerts),
  runs: () => db.select().from(schema.sourceRuns),
  ops: () => db.select().from(schema.opsEvents),
}

// ── Fixture edits for the change scenarios ──────────────────────────────────

const REMOVED_JOB = 5090171007 // AI Tutor - Arabic, xai board
const xaiJobsWithout = (id: number) => {
  const board = JSON.parse(fixtureText('fixtures/hiring/xai-greenhouse.json')) as {
    jobs: { id: number }[]
  }
  return JSON.stringify({ ...board, jobs: board.jobs.filter((j) => j.id !== id) })
}

const XAI_PRICE_LINE = '| grok-4.6 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |'
const xaiPricesRepriced = () => {
  const md = fixtureText('fixtures/pricing/xai-models.md')
  expect(md).toContain(XAI_PRICE_LINE)
  return md.replace(XAI_PRICE_LINE, XAI_PRICE_LINE.replace('$2.00', '$2.50'))
}

const SPCX_CIK = '0001181412'
/** The committed FTS response plus new S-1 hits prepended. */
const ftsWithNewHits = (hits: { adsh: string; cik: string; name: string; form: string }[]) => {
  const doc = JSON.parse(fixtureText('fixtures/sec/edgar-fts.json')) as {
    hits: { hits: unknown[] }
  }
  const extra = hits.map((h) => ({
    _source: {
      adsh: h.adsh,
      form: h.form,
      file_date: '2026-09-01',
      ciks: [h.cik],
      display_names: [h.name],
    },
  }))
  return JSON.stringify({ ...doc, hits: { ...doc.hits, hits: [...extra, ...doc.hits.hits] } })
}

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

describe('scopes', () => {
  it('edgar is the two SEC feeds; survey is every include source', () => {
    expect(sourceIdsForScope('edgar', ALL)).toEqual(['edgar-fts', 'edgar-submissions-spcx'])
    expect(sourceIdsForScope('survey', ALL)).toEqual(ALL_IDS)
    expect(ALL_IDS).toHaveLength(17)
    // The status feeds ride the six-hourly survey only, never the EDGAR tick.
    expect(sourceIdsForScope('edgar', ALL)).not.toContain('openai-status')
  })
})

describe('baseline', () => {
  it('stores entities for every parser source, zero changes, one snapshot and one raw object each', async () => {
    const report = await run('survey', ALL_IDS)

    expect(report.sources).toHaveLength(17)
    expect(report.failed).toBe(0)
    const byId = Object.fromEntries(report.sources.map((s) => [s.source_id, s]))
    // Sides and the cross-check are fetched and snapshotted but yield no entities.
    for (const id of [
      'anthropic-greenhouse-departments',
      'xai-greenhouse-departments',
      'openrouter-models',
    ]) {
      expect(byId[id]).toMatchObject({ status: 'ok', added: 0 })
    }
    for (const id of ALL_IDS.filter((id) => !(id in byId) || byId[id]!.status !== 'ok')) {
      expect(byId[id]!.status).toBe('baseline')
    }
    expect(byId['xai-greenhouse']!.detail).toBe('42 entities')

    expect(await rows.changes()).toHaveLength(0)
    expect(await rows.alerts()).toHaveLength(0)
    expect(await rows.snapshots()).toHaveLength(17)
    expect(await rows.runs()).toHaveLength(17)
    expect(await rows.ops()).toHaveLength(0)

    const entities = await rows.entities()
    const perSource = new Map<string, number>()
    for (const e of entities) perSource.set(e.source_id, (perSource.get(e.source_id) ?? 0) + 1)
    expect(perSource.get('xai-greenhouse')).toBe(42)
    expect(perSource.get('anthropic-greenhouse')).toBe(59)
    expect(perSource.get('openai-ashby')).toBe(65)
    expect(perSource.get('anthropic-pricing-md')).toBe(30)
    expect(perSource.get('edgar-submissions-spcx')).toBe(81)
    // A status feed's whole backlog lands as baseline rows, never as 'added'.
    expect(perSource.get('openai-status')).toBe(25)
    expect(perSource.get('anthropic-status')).toBe(50)
    expect(perSource.get('google-cloud-status')).toBe(1)
    expect(perSource.has('openrouter-models')).toBe(false)
    expect(perSource.get('openrouter-rankings-daily')).toBe(1530)

    // Every stored row carries provenance from the fetch, not the fixture manifest.
    for (const e of entities) {
      expect(e.source_url).toBe(urlOf(e.source_id))
      expect(e.fetched_at).toMatch(/^2026-09-07T10:00:\d\d\.000Z$/)
      expect(e.first_seen_at).toBe(e.fetched_at)
      expect(contentHash(JSON.parse(e.payload))).toBe(e.content_hash)
    }

    // The two Anthropic pages share model keys and coexist because the
    // current set is scoped per source.
    const sonnet = entities.filter((e) => e.entity_key === 'model:anthropic:claude-sonnet-5')
    expect(sonnet.map((e) => e.source_id).sort()).toEqual([
      'anthropic-models-md',
      'anthropic-pricing-md',
    ])

    const keys = await rawKeys()
    expect(keys).toHaveLength(17)
    expect(keys).toContain(
      (await rows.snapshots()).find((s) => s.source_id === 'xai-models-md')!.raw_key,
    )
    expect(keys.find((k) => k.startsWith('raw/xai-models-md/'))).toMatch(
      /^raw\/xai-models-md\/2026-09-07T10:00:\d\d\.000Z\.md$/,
    )
  })

  it('feeds the fleet counters and the per-source freshness on /api/status', async () => {
    await run('edgar', ['edgar-fts', 'edgar-submissions-spcx'])
    const { extra } = await collectFleetCounters(db, now())
    expect(extra.snapshots).toBe(2)
    expect(extra.changes).toBe(0)
    expect(extra.entities).toBeGreaterThan(0)
    expect(extra.lastOkTickEdgarMs).toBeGreaterThan(0)
    expect(extra.lastOkTickSurveyMs).toBe(0)
    expect(extra.lastFailureMs).toBe(0)

    const fresh = await latestFetchBySource(db)
    expect(Object.keys(fresh).sort()).toEqual(['edgar-fts', 'edgar-submissions-spcx'])
    expect(fresh['edgar-fts']).toMatch(/^2026-09-07T/)
  })
})

describe('second run', () => {
  it('with identical bytes writes a snapshot pointing at the existing raw object and no R2 put', async () => {
    await run('survey', ['xai-models-md', 'xai-greenhouse'])
    const first = (await rows.snapshots()).find((s) => s.source_id === 'xai-models-md')!
    const objects = await rawKeys()

    const report = await run('survey', ['xai-models-md', 'xai-greenhouse'])
    expect(report.sources.map((s) => [s.source_id, s.status])).toEqual([
      ['xai-models-md', 'unchanged'],
      ['xai-greenhouse', 'unchanged'],
      ['xai-greenhouse-departments', 'unchanged'],
    ])

    const second = (await rows.snapshots()).filter((s) => s.source_id === 'xai-models-md')
    expect(second).toHaveLength(2)
    expect(second.map((s) => s.raw_key)).toEqual([first.raw_key, first.raw_key])
    expect(await rawKeys()).toEqual(objects)
    expect(await rows.changes()).toHaveLength(0)
  })

  it('with one job removed and one price changed yields exactly those change rows and entity state', async () => {
    await run('survey', ['xai-models-md', 'xai-greenhouse'])
    const before = await rows.entities()
    const beforeJob = before.find((e) => e.entity_key === `job:xai:${REMOVED_JOB}`)!
    const beforePrice = before.find((e) => e.entity_key === 'model:xai:grok-4.6:standard')!

    const report = await run(
      'survey',
      ['xai-models-md', 'xai-greenhouse'],
      fixtureFetcher({
        'xai-greenhouse': xaiJobsWithout(REMOVED_JOB),
        'xai-models-md': xaiPricesRepriced(),
      }),
    )
    const byId = Object.fromEntries(report.sources.map((s) => [s.source_id, s]))
    expect(byId['xai-models-md']).toMatchObject({ status: 'ok', modified: 1, added: 0, removed: 0 })
    expect(byId['xai-greenhouse']).toMatchObject({
      status: 'ok',
      removed: 1,
      added: 0,
      modified: 0,
    })

    const changes = await rows.changes()
    expect(changes.map((c) => [c.entity_key, c.change_type]).sort()).toEqual([
      [`job:xai:${REMOVED_JOB}`, 'removed'],
      ['model:xai:grok-4.6:standard', 'modified'],
    ])
    const removed = changes.find((c) => c.change_type === 'removed')!
    expect(removed.before_hash).toBe(beforeJob.content_hash)
    expect(removed.after_json).toBeNull()
    // A removed row's evidence is its last observation.
    expect(removed.fetched_at).toBe(beforeJob.fetched_at)

    const modified = changes.find((c) => c.change_type === 'modified')!
    expect(modified.before_hash).toBe(beforePrice.content_hash)
    expect(JSON.parse(modified.before_json!).input_per_mtok).toBe(2)
    expect(JSON.parse(modified.after_json!).input_per_mtok).toBe(2.5)
    expect(modified.id).toBe(
      contentHash({
        entity_key: modified.entity_key,
        before_hash: modified.before_hash,
        after_hash: modified.after_hash,
      }),
    )

    const after = await rows.entities()
    expect(after).toHaveLength(before.length - 1)
    expect(after.find((e) => e.entity_key === `job:xai:${REMOVED_JOB}`)).toBeUndefined()
    const price = after.find((e) => e.entity_key === 'model:xai:grok-4.6:standard')!
    expect(price.content_hash).toBe(modified.after_hash)
    expect(JSON.parse(price.payload).input_per_mtok).toBe(2.5)
    expect(price.first_seen_at).toBe(beforePrice.first_seen_at) // never rewritten
    expect(price.fetched_at > beforePrice.fetched_at).toBe(true)
    // Everything else is byte-for-byte what the baseline stored.
    const untouched = (list: typeof before) =>
      list.filter(
        (e) =>
          e.entity_key !== `job:xai:${REMOVED_JOB}` &&
          e.entity_key !== 'model:xai:grok-4.6:standard',
      )
    expect(untouched(after)).toEqual(untouched(before))
  })

  it('re-parses a Greenhouse board when only its /departments join changed', async () => {
    await run('survey', ['xai-greenhouse'])
    const departments = fixtureText('fixtures/hiring/xai-greenhouse-departments.json')
    expect(departments).toContain('"name": "Human Data"')
    const renamed = departments.replace('"name": "Human Data"', '"name": "Human Data Ops"')

    const report = await run(
      'survey',
      ['xai-greenhouse'],
      fixtureFetcher({ 'xai-greenhouse-departments': renamed }),
    )
    const byId = Object.fromEntries(report.sources.map((s) => [s.source_id, s]))
    expect(byId['xai-greenhouse-departments']!.status).toBe('ok')
    // The three fixture jobs under Human Data.
    expect(byId['xai-greenhouse']).toMatchObject({ status: 'ok', modified: 3 })
  })

  it('refuses to turn an empty payload into a mass removal', async () => {
    await run('survey', ['anthropic-greenhouse'])
    const report = await run(
      'survey',
      ['anthropic-greenhouse'],
      fixtureFetcher({ 'anthropic-greenhouse': '{"jobs":[]}' }),
    )
    const board = report.sources.find((s) => s.source_id === 'anthropic-greenhouse')!
    expect(board.status).toBe('failed')
    expect(board.detail).toContain('refusing to record a mass removal')
    expect(
      (await rows.entities()).filter((e) => e.source_id === 'anthropic-greenhouse'),
    ).toHaveLength(59)
    expect(await rows.changes()).toHaveLength(0)
  })

  it('an incident that resolves is one modified change; the rest of the feed is untouched', async () => {
    await run('survey', ['openai-status'])
    const feed = JSON.parse(fixtureText('fixtures/status/openai-status.json')) as {
      incidents: { id: string; status: string; resolved_at?: string }[]
    }
    const open = feed.incidents.find((i) => i.id === '01M20PYYYGRT9303VHAPA7YNT2')!
    expect(open.resolved_at).toBeUndefined()
    open.status = 'resolved'
    open.resolved_at = '2026-09-08T22:30:00Z'

    const report = await run(
      'survey',
      ['openai-status'],
      fixtureFetcher({ 'openai-status': JSON.stringify(feed) }),
    )
    expect(report.sources[0]).toMatchObject({ status: 'ok', added: 0, removed: 0, modified: 1 })
    const [change] = await rows.changes()
    expect(change).toMatchObject({
      entity_key: 'incident:openai:01M20PYYYGRT9303VHAPA7YNT2',
      entity_type: 'incident',
      change_type: 'modified',
    })
    expect(JSON.parse(change!.before_json!).resolved_at).toBeNull()
    expect(JSON.parse(change!.after_json!).resolved_at).toBe('2026-09-08T22:30:00Z')
  })

  it('a filtered feed with no matching rows is an ordinary tick for an append-only lane, and its first row is then added', async () => {
    const feed = JSON.parse(fixtureText('fixtures/status/google-cloud-status.json')) as {
      id: string
      affected_products: { title: string }[]
    }[]
    const withoutGemini = JSON.stringify(
      feed.filter((i) => !i.affected_products.some((p) => p.title === 'Vertex Gemini API')),
    )

    // First observation with zero Gemini rows: a baseline of nothing, not a failure.
    const first = await run(
      'survey',
      ['google-cloud-status'],
      fixtureFetcher({ 'google-cloud-status': withoutGemini }),
    )
    expect(first.sources[0]).toMatchObject({
      status: 'baseline',
      detail: '0 entities; 5 incidents skipped: no Gemini / Vertex AI product',
    })

    // Still nothing: ok, not "refusing to record a mass removal".
    const again = await run(
      'survey',
      ['google-cloud-status'],
      fixtureFetcher({ 'google-cloud-status': withoutGemini.replace('"id":', '"id" :') }),
    )
    expect(again.sources[0]).toMatchObject({ status: 'ok', added: 0, removed: 0, modified: 0 })

    // The real feed: its one Gemini incident is the first 'added' change.
    const third = await run('survey', ['google-cloud-status'])
    expect(third.sources[0]).toMatchObject({ status: 'ok', added: 1 })
    expect((await rows.changes()).map((c) => [c.entity_key, c.change_type])).toEqual([
      ['incident:google:41E5S3mkTGDfkZuJZH5k', 'added'],
    ])
    expect(await rows.ops()).toHaveLength(0)
  })

  it('keeps filings that scroll out of an append-only feed', async () => {
    await run('edgar', ['edgar-submissions-spcx'])
    const doc = JSON.parse(fixtureText('fixtures/sec/edgar-submissions-spcx.json')) as {
      filings: { recent: Record<string, unknown[]> }
    }
    const recent = Object.fromEntries(
      Object.entries(doc.filings.recent).map(([k, v]) => [k, v.slice(1)]),
    )
    const trimmed = JSON.stringify({ ...doc, filings: { ...doc.filings, recent } })

    const report = await run(
      'edgar',
      ['edgar-submissions-spcx'],
      fixtureFetcher({ 'edgar-submissions-spcx': trimmed }),
    )
    expect(report.sources[0]).toMatchObject({ status: 'ok', added: 0, removed: 0, modified: 0 })
    expect((await rows.entities()).filter((e) => e.entity_type === 'filing')).toHaveLength(81)
    expect(await rows.changes()).toHaveLength(0)
  })
})

describe('s1-floor', () => {
  it('a new S-1 on a whitelisted CIK alerts; historical ones in the baseline and non-whitelist hits do not', async () => {
    await run('edgar', ['edgar-fts', 'edgar-submissions-spcx'])
    // The committed feeds already hold SPCX S-1 filings — a baseline is not news.
    expect(await rows.alerts()).toHaveLength(0)

    const report = await run(
      'edgar',
      ['edgar-fts'],
      fixtureFetcher({
        'edgar-fts': ftsWithNewHits([
          {
            adsh: '0001628280-26-099999',
            cik: SPCX_CIK,
            name: 'SPACE EXPLORATION TECHNOLOGIES CORP  (SPCX)  (CIK 0001181412)',
            form: 'S-1/A',
          },
          { adsh: '0009999999-26-000001', cik: '0009999999', name: 'Noise Corp', form: 'S-1' },
        ]),
      }),
    )
    expect(report.sources[0]).toMatchObject({ status: 'ok', added: 2, alerts: 1 })

    const [alert, ...others] = await rows.alerts()
    expect(others).toHaveLength(0)
    const change = (await rows.changes()).find(
      (c) => c.entity_key === 'filing:0001628280-26-099999',
    )!
    expect(alert).toMatchObject({
      rule: 's1-floor',
      severity: 'critical',
      change_ids: JSON.stringify([change.id]),
      created_at: change.detected_at,
      source_url: urlOf('edgar-fts'),
      fetched_at: change.fetched_at,
    })
    expect(alert!.headline).toBe(
      'S-1/A filed by SPACE EXPLORATION TECHNOLOGIES CORP  (SPCX)  (CIK 0001181412) (2026-09-01)',
    )
    expect(alert!.explanation).toContain('Accession 0001628280-26-099999')
    expect(alert!.explanation).toContain(`CIK ${SPCX_CIK}`)
  })
})

describe('failures', () => {
  it('a failed fetch is a failed run with an ops event, and the tick carries on', async () => {
    const report = await run(
      'survey',
      ['xai-models-md', 'openai-models-md'],
      fixtureFetcher({
        'xai-models-md': { ok: false, status: 503, detail: 'HTTP 503 after 3 attempts' },
      }),
    )
    expect(report.sources.map((s) => [s.source_id, s.status])).toEqual([
      ['openai-models-md', 'baseline'],
      ['xai-models-md', 'failed'],
    ])
    expect(report.failed).toBe(1)
    expect(report.all_failed).toBe(false)

    const runs = await rows.runs()
    const failed = runs.find((r) => r.source_id === 'xai-models-md')!
    expect(failed).toMatchObject({
      status: 'failed',
      detail: 'HTTP 503 after 3 attempts',
      snapshot_id: null,
      source_url: urlOf('xai-models-md'),
    })
    expect((await rows.snapshots()).map((s) => s.source_id)).toEqual(['openai-models-md'])

    const ops = await rows.ops()
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      kind: 'source_failed',
      detail: 'xai-models-md: HTTP 503 after 3 attempts',
      path: urlOf('xai-models-md'),
    })
  })

  it('a parser whose output fails its schema stores the snapshot and nothing else', async () => {
    const report = await run(
      'survey',
      ['openai-ashby'],
      fixtureFetcher({ 'openai-ashby': '{"jobs":[{"id":"abc","title":""}]}' }),
    )
    const ashby = report.sources[0]!
    expect(ashby.status).toBe('failed')
    expect(ashby.detail).toContain('rows.0.title')
    expect(ashby.snapshot_id).not.toBeNull()
    expect(await rows.snapshots()).toHaveLength(1)
    expect(await rows.entities()).toHaveLength(0)
    // The only source in the tick failed, so the tick as a whole did too.
    expect((await rows.ops()).map((o) => o.kind)).toEqual(['source_failed', 'all_sources_failed'])
  })

  it('SEC sources are refused, not fetched, without the contact email', async () => {
    // The real fetcher with the real refusal; a fetch that throws proves it was never called.
    const { createFetcher } = await import('../../server/pipeline/fetch')
    const fetcher = createFetcher({
      secContactEmail: '',
      appUrl: 'https://frontier-terminal.example',
      fetch: async () => {
        throw new Error('network reached')
      },
      sleep: async () => {},
    })
    const report = await runRefresh(deps(fetcher), 'edgar', ['edgar-fts', 'edgar-submissions-spcx'])
    expect(report.sources.map((s) => s.detail)).toEqual([
      'NUXT_SEC_CONTACT_EMAIL unset',
      'NUXT_SEC_CONTACT_EMAIL unset',
    ])
    expect(report.all_failed).toBe(true)
    expect((await rows.ops()).map((o) => o.kind)).toEqual([
      'source_failed',
      'source_failed',
      'all_sources_failed',
    ])
  })

  it('a Greenhouse board cannot be parsed when its /departments fetch failed this tick', async () => {
    const report = await run(
      'survey',
      ['xai-greenhouse'],
      fixtureFetcher({
        'xai-greenhouse-departments': { ok: false, status: 500, detail: 'HTTP 500' },
      }),
    )
    const byId = Object.fromEntries(report.sources.map((s) => [s.source_id, s]))
    expect(byId['xai-greenhouse']).toMatchObject({
      status: 'failed',
      detail: 'side source xai-greenhouse-departments unavailable this tick',
    })
    expect(await rows.entities()).toHaveLength(0)
  })

  it('rejects a source id that is not an include source', async () => {
    await expect(run('survey', ['google-hiring'])).rejects.toThrow('not include sources')
  })
})
