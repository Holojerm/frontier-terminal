import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { contentHash } from '../server/pipeline/contracts'
import type { SourceFetcher } from '../server/pipeline/fetch'
import { runRefresh, type RawStore, type RefreshDeps } from '../server/pipeline/refresh'
import { includeSources } from '../server/pipeline/sources'
import { terminalStamp } from '../server/utils/terminal-cache'
import {
  queryContext,
  queryHiringHistory,
  queryPriceHistory,
  queryPriceKeys,
  queryPrices,
  queryReleases,
} from '../server/utils/terminal-db'
import {
  baselineInstants,
  compareWindow,
  dailyInstants,
  departmentSeries,
  isBaseline,
  openRolesAt,
  priceHistory,
  releaseEvents,
  sparkOf,
} from '../server/utils/terminal-history'
import { fixtureText, manifest } from './pipeline/fixtures'

// The three history derivations, first as pure functions over a handful of
// typed rows (every rule has one row that exercises it), then against a real
// D1 seeded through runRefresh so the D1 queries and the derivations agree.

type Change = typeof schema.changes.$inferSelect
type Entity = typeof schema.entities.$inferSelect

const URL_A = 'https://docs.x.ai/developers/models.md'
const URL_B = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
const sourceIdOf = (url: string) => (url === URL_A ? 'xai-models-md' : 'anthropic-pricing-md')

const price = (input: number | null, output: number | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model_slug: 'grok-4.6',
    tier: 'standard',
    input_per_mtok: input,
    cached_input_per_mtok: null,
    output_per_mtok: output,
    ...extra,
  })

function change(
  over: Partial<Change> & Pick<Change, 'id' | 'change_type' | 'detected_at'>,
): Change {
  const before = over.before_json ?? null
  const after = over.after_json ?? null
  return {
    entity_key: 'model:xai:grok-4.6:standard',
    entity_type: 'model',
    provider: 'xai',
    before_hash: before === null ? null : contentHash(before),
    after_hash: after === null ? null : contentHash(after),
    before_json: before,
    after_json: after,
    source_url: URL_A,
    fetched_at: over.detected_at,
    ...over,
  }
}

function entity(over: Partial<Entity> & Pick<Entity, 'entity_key' | 'payload'>): Entity {
  return {
    source_id: 'xai-models-md',
    entity_type: 'model',
    provider: 'xai',
    content_hash: contentHash(over.payload),
    snapshot_id: 'xai-models-md:2026-09-08T06:00:00.000Z',
    first_seen_at: '2026-09-08T06:00:00.000Z',
    source_url: URL_A,
    fetched_at: '2026-09-08T06:00:00.000Z',
    ...over,
  }
}

describe('baselineInstants', () => {
  const snapshots = [
    { id: 's1', source_url: URL_A, fetched_at: '2026-08-25T11:10:41Z' },
    { id: 's2', source_url: URL_A, fetched_at: '2026-08-25T22:16:44.740Z' },
    { id: 's3', source_url: URL_B, fetched_at: '2026-08-26T00:00:00.000Z' },
    { id: 's4', source_url: URL_B, fetched_at: '2026-09-08T06:00:00.000Z' },
  ]

  it('marks the first snapshot per source, plus any a run calls baseline', () => {
    const instants = baselineInstants(snapshots, [
      { status: 'baseline', snapshot_id: 's4' },
      { status: 'ok', snapshot_id: 's2' },
    ])
    expect([...instants].sort()).toEqual([
      `${URL_A}\n2026-08-25T11:10:41Z`,
      `${URL_B}\n2026-08-26T00:00:00.000Z`,
      `${URL_B}\n2026-09-08T06:00:00.000Z`,
    ])
    // Only an `added` row can be a baseline sighting.
    const added = change({
      id: 'a',
      change_type: 'added',
      detected_at: '2026-08-25T11:10:41Z',
      after_json: price(2, 6),
    })
    expect(isBaseline(added, instants)).toBe(true)
    expect(isBaseline({ ...added, change_type: 'modified' }, instants)).toBe(false)
    expect(isBaseline({ ...added, fetched_at: '2026-08-25T22:16:44.740Z' }, instants)).toBe(false)
  })
})

describe('priceHistory', () => {
  const modified = change({
    id: 'm',
    change_type: 'modified',
    detected_at: '2026-08-28T10:23:00.000Z',
    before_json: price(2, 6),
    after_json: price(2.5, 6),
  })
  const removed = change({
    id: 'r',
    change_type: 'removed',
    detected_at: '2026-09-02T00:35:00.000Z',
    before_json: price(2.5, 6),
    fetched_at: '2026-09-01T17:45:00.000Z',
  })
  const firstSnapshot = (url: string) => (url === URL_A ? '2026-08-25T11:10:41Z' : null)

  it('opens with the before state as of the first snapshot, then every change', () => {
    const points = priceHistory([], [modified, removed], sourceIdOf, firstSnapshot)
    expect(points.map((p) => [p.kind, p.at, p.input_per_mtok])).toEqual([
      ['baseline', '2026-08-25T11:10:41Z', 2],
      ['modified', '2026-08-28T10:23:00.000Z', 2.5],
      ['removed', '2026-09-02T00:35:00.000Z', 2.5],
    ])
    // The opening point is stamped with the snapshot it rests on.
    expect(points[0]).toMatchObject({
      source_id: 'xai-models-md',
      source_url: URL_A,
      fetched_at: '2026-08-25T11:10:41Z',
    })
    expect(points[1]!.diff).toEqual([{ field: 'input_per_mtok', before: '2', after: '2.5' }])
    // A removal keeps the provenance of the last observation of the row.
    expect(points[2]!.fetched_at).toBe('2026-09-01T17:45:00.000Z')
  })

  it('has no opening point without a first snapshot earlier than the change', () => {
    expect(priceHistory([], [modified], sourceIdOf).map((p) => p.kind)).toEqual(['modified'])
  })

  it('adds the current row as a point unless a change already recorded that fetch', () => {
    const same = entity({
      entity_key: 'model:xai:grok-4.6:standard',
      payload: price(2.5, 6),
      fetched_at: modified.fetched_at,
    })
    expect(priceHistory([same], [modified], sourceIdOf).map((p) => p.kind)).toEqual(['modified'])

    const later = { ...same, fetched_at: '2026-09-08T06:00:00.000Z' }
    const points = priceHistory([later], [modified], sourceIdOf)
    expect(points.map((p) => [p.kind, p.at])).toEqual([
      ['modified', '2026-08-28T10:23:00.000Z'],
      ['current', '2026-09-08T06:00:00.000Z'],
    ])
  })

  it('sparkline: input when any exists, else output, null under two points', () => {
    const points = priceHistory([], [modified, removed], sourceIdOf, firstSnapshot)
    expect(sparkOf(points)).toEqual({ field: 'input_per_mtok', values: [2, 2.5, 2.5] })
    expect(sparkOf(points.slice(0, 1))).toBeNull()
    const outputOnly = points.map((p) => ({ ...p, input_per_mtok: null }))
    expect(sparkOf(outputOnly)).toEqual({ field: 'output_per_mtok', values: [6, 6, 6] })
  })
})

describe('releaseEvents', () => {
  const baseline = new Set([`${URL_B}\n2026-08-25T22:16:44.993Z`])
  const first = change({
    id: 'b',
    entity_key: 'model:anthropic:claude-sonnet-5',
    provider: 'anthropic',
    change_type: 'added',
    detected_at: '2026-08-25T22:16:44.993Z',
    after_json: price(3, 15, { model_slug: 'claude-sonnet-5', tier: null }),
    source_url: URL_B,
  })
  const listed = change({
    id: 'l',
    entity_key: 'model:anthropic:claude-fable-5-1',
    provider: 'anthropic',
    change_type: 'added',
    detected_at: '2026-09-02T00:35:20.016Z',
    after_json: price(10, 50, {
      model_slug: 'claude-fable-5-1',
      tier: null,
      notes: 'cache $12.50',
    }),
    source_url: URL_B,
  })
  const older = change({
    id: 'o',
    change_type: 'added',
    detected_at: '2026-08-28T10:23:00.000Z',
    after_json: price(null, null),
  })

  it('folds two pages listing one key into one release, the priced sighting first', () => {
    const overview = change({
      ...listed,
      id: 'l2',
      after_json: price(null, null, { model_slug: 'claude-fable-5-1', tier: null }),
      source_url: 'https://platform.claude.com/docs/en/models/overview.md',
    })
    const { rows } = releaseEvents([overview, listed], baseline, () => 'anthropic-models-md')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.input_per_mtok).toBe(10)
    expect(rows[0]!.also_listed_by).toEqual(['anthropic-models-md'])
  })

  it('keeps post-baseline listings newest first and counts what it dropped', () => {
    const { rows, excluded_baseline } = releaseEvents(
      [
        first,
        older,
        listed,
        change({
          id: 'x',
          change_type: 'modified',
          detected_at: '2026-09-03T00:00:00Z',
          before_json: price(1, 1),
          after_json: price(2, 2),
        }),
      ],
      baseline,
      sourceIdOf,
    )
    expect(excluded_baseline).toBe(1)
    expect(rows.map((r) => r.entity_key)).toEqual([
      'model:anthropic:claude-fable-5-1',
      'model:xai:grok-4.6:standard',
    ])
    expect(rows[0]).toMatchObject({
      change_id: 'l',
      source_id: 'anthropic-pricing-md',
      model_slug: 'claude-fable-5-1',
      first_seen_at: '2026-09-02T00:35:20.016Z',
      input_per_mtok: 10,
      output_per_mtok: 50,
      notes: 'cache $12.50',
      source_url: URL_B,
      fetched_at: '2026-09-02T00:35:20.016Z',
    })
    expect(rows[1]).toMatchObject({ tier: 'standard', input_per_mtok: null, also_listed_by: [] })
  })
})

describe('openRolesAt', () => {
  const JOBS = 'https://boards-api.greenhouse.io/v1/boards/xai/jobs'
  const job = (department: string) => JSON.stringify({ title: 't', department })
  const jobChange = (
    id: string,
    key: string,
    type: Change['change_type'],
    detected_at: string,
    before: string | null,
    after: string | null,
  ): Change =>
    change({
      id,
      entity_key: key,
      entity_type: 'job',
      provider: 'xai',
      change_type: type,
      detected_at,
      before_json: before,
      after_json: after,
      source_url: JOBS,
    })
  const current = [
    { entity_key: 'job:xai:A', provider: 'xai', department: 'Engineering' },
    { entity_key: 'job:xai:B', provider: 'xai', department: 'Human Data' },
  ]
  const changes = [
    jobChange('1', 'job:xai:A', 'added', '2026-09-02T00:00:00Z', null, job('Engineering')),
    jobChange('2', 'job:xai:C', 'removed', '2026-09-03T00:00:00Z', job('Engineering'), null),
    jobChange(
      '3',
      'job:xai:B',
      'modified',
      '2026-09-04T00:00:00Z',
      job('Data Center'),
      job('Human Data'),
    ),
    // Opened and closed between the last imported poll and this store's
    // baseline: in the log as added, absent from the current set.
    jobChange('4', 'job:xai:D', 'added', '2026-09-02T12:00:00Z', null, job('Engineering')),
  ]
  const at = (instant: string, dept: string) =>
    openRolesAt(current, changes, [instant]).get(instant)!.get('xai')?.get(dept) ?? 0

  it('undoes the log backwards from the current set', () => {
    expect(at('2026-09-05T00:00:00Z', 'Engineering')).toBe(1)
    expect(at('2026-09-05T00:00:00Z', 'Human Data')).toBe(1)
    // Before B's department changed it sat in Data Center.
    expect(at('2026-09-03T12:00:00Z', 'Data Center')).toBe(1)
    expect(at('2026-09-03T12:00:00Z', 'Human Data')).toBe(0)
    // Before C was removed it was open.
    expect(at('2026-09-02T18:00:00Z', 'Engineering')).toBe(2)
    // Before A was added — and D, never in the current set, is skipped, not negative.
    expect(at('2026-09-01T00:00:00Z', 'Engineering')).toBe(1)
    expect(at('2026-09-01T00:00:00Z', 'Data Center')).toBe(1)
  })

  it('reads several instants in one pass, whatever their order', () => {
    const out = openRolesAt(current, changes, ['2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z'])
    expect(out.get('2026-09-05T00:00:00Z')!.get('xai')!.get('Engineering')).toBe(1)
    expect(out.get('2026-09-01T00:00:00Z')!.get('xai')!.get('Engineering')).toBe(1)
    expect(out.get('2026-09-01T00:00:00Z')!.get('xai')!.get('Data Center')).toBe(1)
  })

  it('daily grid, department rows and the comparison window', () => {
    const grid = dailyInstants('2026-09-01', '2026-09-05T10:00:00.000Z')
    expect(grid).toEqual([
      { date: '2026-09-01', at: '2026-09-01T23:59:59.999Z' },
      { date: '2026-09-02', at: '2026-09-02T23:59:59.999Z' },
      { date: '2026-09-03', at: '2026-09-03T23:59:59.999Z' },
      { date: '2026-09-04', at: '2026-09-04T23:59:59.999Z' },
      { date: '2026-09-05', at: '2026-09-05T10:00:00.000Z' },
    ])
    const byInstant = openRolesAt(
      current,
      changes,
      grid.map((g) => g.at),
    )
    const { total, departments } = departmentSeries(byInstant, grid, 'xai')
    expect(total).toEqual([2, 3, 2, 2, 2])
    expect(departments.map((d) => [d.department, d.series])).toEqual([
      ['Engineering', [1, 2, 1, 1, 1]],
      ['Human Data', [0, 0, 0, 1, 1]],
      ['Data Center', [1, 1, 1, 0, 0]],
    ])
    const dates = grid.map((g) => g.date)
    // 30 days back is before the series starts: compare against its first day and say so.
    expect(compareWindow(dates, total, departments, 30)).toEqual({
      at: '2026-09-01',
      days: 4,
      total_then: 2,
      total_now: 2,
      departments: [
        { department: 'Engineering', then: 1, now: 1 },
        { department: 'Human Data', then: 0, now: 1 },
        { department: 'Data Center', then: 1, now: 0 },
      ],
    })
    expect(compareWindow(dates, total, departments, 2)!.at).toBe('2026-09-03')
    expect(compareWindow(dates.slice(0, 1), total, departments, 30)).toBeNull()
  })
})

// ── Against a real D1 ────────────────────────────────────────────────────────

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const ALL = includeSources(sourcesYaml, manifest.fixtures)
const ALL_IDS = ALL.map((s) => s.source_id)
const urlOf = (id: string) => ALL.find((s) => s.source_id === id)!.url

function fixtureFetcher(overrides: Record<string, string> = {}): SourceFetcher {
  const byUrl = new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))
  return async (source) => {
    const text = overrides[source.source_id] ?? byUrl.get(source.url)
    if (text === undefined) throw new Error(`no fixture for ${source.url}`)
    return { ok: true, status: 200, text, bytes: text.length }
  }
}

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}

let tick = Date.parse('2026-09-07T10:00:00Z')
const now = () => new Date((tick += 1000))
const deps = (fetcher: SourceFetcher): RefreshDeps => ({ db, raw, fetcher, sourcesYaml, now })
const run = (ids: readonly string[], fetcher = fixtureFetcher()) =>
  runRefresh(deps(fetcher), 'survey', ids)

const FIXED_NOW = () => new Date('2026-09-09T12:00:00Z')
const ctx = async () => queryContext(sourcesYaml, await terminalStamp(db), FIXED_NOW)

const GROK = 'model:xai:grok-4.6:standard'
const XAI_PRICE_LINE = '| grok-4.6 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |'
const NEW_LINE = '| grok-5-preview (< 200k prompt tokens) | 1M | $4.00 | $1.00 | $12.00 |'
const xaiRepricedAndListed = () => {
  const md = fixtureText('fixtures/pricing/xai-models.md')
  expect(md).toContain(XAI_PRICE_LINE)
  return md.replace(XAI_PRICE_LINE, `${XAI_PRICE_LINE.replace('$2.00', '$2.50')}\n${NEW_LINE}`)
}
const REMOVED_JOB = 5090171007
const xaiJobsWithout = (id: number) => {
  const board = JSON.parse(fixtureText('fixtures/hiring/xai-greenhouse.json')) as {
    jobs: { id: number }[]
  }
  return JSON.stringify({ ...board, jobs: board.jobs.filter((j) => j.id !== id) })
}

describe('the history queries on an empty store', () => {
  beforeEach(async () => {
    for (const table of [schema.sourceRuns, schema.changes, schema.entities, schema.snapshots]) {
      await db.delete(table)
    }
  })

  it('answer honestly and never throw', async () => {
    const c = await ctx()
    expect(await queryPriceHistory(db, c, GROK)).toBeNull()
    expect(await queryPriceKeys(db)).toEqual([])
    const releases = await queryReleases(db, c)
    expect(releases).toMatchObject({ rows: [], excluded_baseline: 0, log_from: null })
    const hiring = await queryHiringHistory(db, c)
    expect(hiring.window_days).toBe(30)
    expect(hiring.log).toEqual({ changes: 0, from: null, to: null })
    for (const p of hiring.providers) {
      expect(p.dates).toEqual([])
      expect(p.compare).toBeNull()
    }
    expect(hiring.providers[2]).toMatchObject({ provider: 'google', feed: 'no_public_feed' })
    expect(hiring.providers[3]!.caveat).toContain('SpaceXAI')
  })
})

describe('after a baseline and a second poll', () => {
  beforeEach(async () => {
    for (const table of [schema.sourceRuns, schema.changes, schema.entities, schema.snapshots]) {
      await db.delete(table)
    }
    tick = Date.parse('2026-09-07T10:00:00Z')
    await run(ALL_IDS)
    tick = Date.parse('2026-09-08T10:00:00Z')
    await run(
      ['xai-models-md', 'xai-greenhouse'],
      fixtureFetcher({
        'xai-models-md': xaiRepricedAndListed(),
        'xai-greenhouse': xaiJobsWithout(REMOVED_JOB),
      }),
    )
  })

  it('price history: the baseline price opens the series, the reprice follows, the current row is the same fetch', async () => {
    const history = (await queryPriceHistory(db, await ctx(), GROK))!
    expect(history).toMatchObject({
      entity_key: GROK,
      provider: 'xai',
      model_slug: 'grok-4.6',
      tier: 'standard',
      removed: false,
    })
    expect(history.points.map((p) => [p.kind, p.input_per_mtok, p.output_per_mtok])).toEqual([
      ['baseline', 2, 6],
      ['modified', 2.5, 6],
    ])
    expect(history.points[0]!.at).toMatch(/^2026-09-07T10:0\d:/)
    expect(history.points[0]!.source_url).toBe(urlOf('xai-models-md'))
    expect(history.points[1]!.at).toMatch(/^2026-09-08T10:0\d:/)
    expect(history.points[1]!.diff).toEqual([
      { field: 'input_per_mtok', before: '2', after: '2.5' },
    ])

    // The catalog row carries the same observations as a sparkline.
    const prices = await queryPrices(db, await ctx())
    const grok = prices.rows.find((r) => r.entity_key === GROK)!
    expect(grok.revisions).toBe(2)
    expect(grok.spark).toEqual({ field: 'input_per_mtok', values: [2, 2.5] })
    // Listed by two pages at one instant is two sources, not two revisions.
    const untouched = prices.rows.find((r) => r.entity_key === 'model:anthropic:claude-sonnet-5')!
    expect(untouched.revisions).toBe(1)
    expect(untouched.spark).toBeNull()
  })

  it('releases: the new SKU is listed with its price; the baseline is not', async () => {
    const releases = await queryReleases(db, await ctx())
    expect(releases.rows.map((r) => r.entity_key)).toEqual(['model:xai:grok-5-preview:standard'])
    expect(releases.rows[0]).toMatchObject({
      provider: 'xai',
      source_id: 'xai-models-md',
      model_slug: 'grok-5-preview',
      input_per_mtok: 4,
      output_per_mtok: 12,
      source_url: urlOf('xai-models-md'),
    })
    expect(releases.rows[0]!.first_seen_at).toMatch(/^2026-09-08T10:0\d:/)
    // This Worker's baseline writes no change rows, so there was nothing to exclude.
    expect(releases.excluded_baseline).toBe(0)
    expect(releases.log_from).toMatch(/^2026-09-07T10:0\d:/)
  })

  it('sitemap keys: every SKU on record, dated by its newest observation', async () => {
    const keys = await queryPriceKeys(db)
    const byKey = Object.fromEntries(keys.map((k) => [k.entity_key, k.lastmod]))
    expect(byKey[GROK]).toBe('2026-09-08')
    expect(byKey['model:xai:grok-5-preview:standard']).toBe('2026-09-08')
    expect(byKey['model:anthropic:claude-sonnet-5']).toBe('2026-09-07')
    expect(keys.map((k) => k.entity_key)).toEqual([...keys.map((k) => k.entity_key)].sort())
  })

  it('hiring history: the closed role counts on the day before, not after', async () => {
    const hiring = await queryHiringHistory(db, await ctx())
    const xai = hiring.providers.find((p) => p.provider === 'xai')!
    expect(xai.feed).toBe('ok')
    expect(xai.dates).toEqual(['2026-09-07', '2026-09-08', '2026-09-09'])
    expect(xai.total).toEqual([42, 41, 41])
    expect(xai.series_from).toMatch(/^2026-09-07T10:0\d:/)
    expect(xai.baseline_at).toMatch(/^2026-09-07T10:0\d:/)
    expect(xai.join_from).toMatch(/^2026-09-07T10:0\d:/)
    expect(xai.departments[0]!.department).toBe('Data Center')
    expect(xai.departments.reduce((n, d) => n + d.series.at(-1)!, 0)).toBe(41)
    expect(xai.compare).toMatchObject({ at: '2026-09-07', days: 2, total_then: 42, total_now: 41 })
    expect(xai.caveat).toContain('SpaceXAI')
    expect(xai.sources.map((s) => s.source_id)).toEqual([
      'xai-greenhouse',
      'xai-greenhouse-departments',
    ])

    const openai = hiring.providers.find((p) => p.provider === 'openai')!
    expect(openai.total).toEqual([65, 65, 65])
    expect(openai.join_from).toBeNull()
    expect(hiring.log.changes).toBe(1)
  })
})
