import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { contentHashOfText } from '../server/pipeline/contracts'
import type { FetchOutcome, SourceFetcher } from '../server/pipeline/fetch'
import { runRefresh, type RawStore, type RefreshDeps } from '../server/pipeline/refresh'
import { includeSources } from '../server/pipeline/sources'
import { AlertRow, contentHash } from '../server/pipeline/contracts'
import { insertRows } from '../server/pipeline/store'
import { terminalStamp } from '../server/utils/terminal-cache'
import { MODEL_CLASS_MAP } from '../server/utils/terminal-classes'
import {
  alertPermalinks,
  fieldDiff,
  fieldTable,
  queryAlert,
  queryAlerts,
  queryContext,
  queryCoverage,
  queryHiring,
  queryOverview,
  queryPrices,
} from '../server/utils/terminal-db'
import { fixtureText, manifest } from './pipeline/fixtures'

// The UI's query layer against a real D1, seeded the way production is: the
// committed fixtures pushed through runRefresh (fetch → parse → normalize →
// diff → insertRows), so every row carries live provenance and every value
// was read from a fixture rather than typed here. The take-home's golden
// assertions are ported: jobs are counted from the current set, the newest
// price revision wins, every class quote greps back out of its fixture, and
// the signal window is anchored to the newest detection.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const ALL = includeSources(sourcesYaml, manifest.fixtures)
const ALL_IDS = ALL.map((s) => s.source_id)
const urlOf = (id: string) => ALL.find((s) => s.source_id === id)!.url

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

let tick = Date.parse('2026-09-07T10:00:00Z')
const now = () => new Date((tick += 1000))
const deps = (fetcher: SourceFetcher): RefreshDeps => ({ db, raw, fetcher, sourcesYaml, now })
const run = (ids: readonly string[], fetcher = fixtureFetcher()) =>
  runRefresh(deps(fetcher), 'survey', ids)

const FIXED_NOW = () => new Date('2026-09-07T12:00:00Z')
const ctx = async () => queryContext(sourcesYaml, await terminalStamp(db), FIXED_NOW)

// ── Fixture edits for the change scenarios ──────────────────────────────────

const REMOVED_JOB = 5090171007 // AI Tutor - Arabic, xai board
const xaiJobsWithout = (id: number) => {
  const board = JSON.parse(fixtureText('fixtures/hiring/xai-greenhouse.json')) as {
    jobs: { id: number }[]
  }
  return JSON.stringify({ ...board, jobs: board.jobs.filter((j) => j.id !== id) })
}

const XAI_PRICE_LINE = '| grok-4.6 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |'
const xaiRepricedAndDelisted = () => {
  const md = fixtureText('fixtures/pricing/xai-models.md')
  expect(md).toContain(XAI_PRICE_LINE)
  return md
    .replace(XAI_PRICE_LINE, XAI_PRICE_LINE.replace('$2.00', '$2.50'))
    .split('\n')
    .filter((line) => !line.startsWith('| grok-build-0.1 ('))
    .join('\n')
}

const SPCX_CIK = '0001181412'
const ftsWithNewS1 = () => {
  const doc = JSON.parse(fixtureText('fixtures/sec/edgar-fts.json')) as {
    hits: { hits: unknown[] }
  }
  const hit = {
    _source: {
      adsh: '0001628280-26-099999',
      form: 'S-1/A',
      file_date: '2026-09-01',
      ciks: [SPCX_CIK],
      display_names: ['SPACE EXPLORATION TECHNOLOGIES CORP  (SPCX)  (CIK 0001181412)'],
    },
  }
  return JSON.stringify({ ...doc, hits: { ...doc.hits, hits: [hit, ...doc.hits.hits] } })
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

describe('an empty store renders an honest empty state, never a throw', () => {
  it('overview: nothing polled, nothing compared, nothing alerted', async () => {
    const c = await ctx()
    expect(c.as_of).toBeNull()
    const overview = await queryOverview(db, c)
    expect(overview.as_of).toBeNull()
    expect(overview.computed_at).toBe('2026-09-07T12:00:00.000Z')
    expect(overview.movement).toEqual({
      latest_detected_at: null,
      window_from: null,
      window_hours: 24,
      recent: { pricing: 0, hiring: 0, sec: 0, total: 0 },
      total_changes: 0,
      sources_total: 0,
      sources_not_yet_compared: 0,
    })
    expect(overview.alerts).toEqual([])
    expect(overview.totals).toEqual({
      snapshots: 0,
      entities: 0,
      changes: 0,
      alerts: 0,
      source_runs: 0,
    })
    expect(overview.latest_fetched_at).toBeNull()
  })

  it('prices: twelve matrix cells, each with a stated gap and no invented number', async () => {
    const prices = await queryPrices(db, await ctx())
    expect(prices.rows).toEqual([])
    expect(prices.matrix.cells).toHaveLength(12)
    for (const cell of prices.matrix.cells) {
      expect(cell.priced).toBe(false)
      expect(cell.row).toBeNull()
      expect(cell.gap).toBeTruthy()
    }
    expect(prices.changes_available).toBe(false)
    expect(prices.cross_check).toBeNull()
  })

  it('hiring: Google is a stated cut; the other three say no rows, not zero roles', async () => {
    const hiring = await queryHiring(db, await ctx())
    expect(hiring.providers.map((p) => p.provider)).toEqual([
      'openai',
      'anthropic',
      'google',
      'xai',
    ])
    const google = hiring.providers[2]!
    expect(google.feed).toBe('no_public_feed')
    expect(google.reason).toContain('auth-walled')
    for (const p of hiring.providers.filter((p) => p.provider !== 'google')) {
      expect(p.feed).toBe('no_rows')
      expect(p.total).toBe(0)
      expect(p.sources).toEqual([])
    }
    // The caveat ships even before any row lands.
    expect(hiring.providers[3]!.caveat).toContain('SpaceXAI')
  })

  it('coverage: every registered source is listed as never fetched', async () => {
    const coverage = await queryCoverage(db, await ctx())
    expect(coverage.sources.map((s) => s.source_id).sort()).toEqual([...ALL_IDS].sort())
    for (const s of coverage.sources) {
      expect(s.newest_snapshot).toBeNull()
      expect(s.last_run).toBeNull()
      expect(s.snapshot_count).toBe(0)
      expect(s.url).toMatch(/^https?:\/\//)
    }
    expect(coverage.cuts.map((c) => c.id)).toContain('google-hiring')
    expect(coverage.exports.map((e) => e.name)).toEqual([
      'snapshots',
      'prices_latest',
      'jobs_open',
      'changes',
      'alerts',
      'source_runs',
    ])
  })
})

describe('after a baseline poll of every source', () => {
  beforeEach(async () => {
    await run(ALL_IDS)
  })

  it('the signal band says first-observation, not calm', async () => {
    const { movement, latest_fetched_at, as_of } = await queryOverview(db, await ctx())
    expect(as_of).toMatch(/^2026-09-07T10:0\d:/)
    expect(movement.total_changes).toBe(0)
    expect(movement.latest_detected_at).toBeNull()
    expect(movement.sources_total).toBe(13)
    // Every source has exactly one snapshot => nothing could have been
    // diffed. That is a different sentence from "nothing changed".
    expect(movement.sources_not_yet_compared).toBe(13)
    expect(latest_fetched_at).toMatch(/^2026-09-07T10:0\d:/)
  })

  it('prices: fixture values, live provenance, priced rows first', async () => {
    const prices = await queryPrices(db, await ctx())
    const grok = prices.rows.find((r) => r.entity_key === 'model:xai:grok-4.6:standard')!
    // "| grok-4.6 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |"
    expect(grok).toMatchObject({
      provider: 'xai',
      tier: 'standard',
      context_window: '500k',
      input_per_mtok: 2,
      cached_input_per_mtok: 0.5,
      output_per_mtok: 6,
      source_url: urlOf('xai-models-md'),
      removed: false,
      delta: null,
    })
    expect(grok.fetched_at).toMatch(/^2026-09-07T10:0\d:/)

    // The two Anthropic pages carry the same SKU key: one row, the other cited.
    const sonnet = prices.rows.filter((r) => r.entity_key === 'model:anthropic:claude-sonnet-5')
    expect(sonnet).toHaveLength(1)
    expect(sonnet[0]!.also_listed_by).toHaveLength(1)
    expect(['anthropic-models-md', 'anthropic-pricing-md']).toContain(sonnet[0]!.source_id)
    expect(['anthropic-models-md', 'anthropic-pricing-md']).toContain(sonnet[0]!.also_listed_by[0])

    // Priced rows lead; once a catalog-only row appears no priced row follows.
    const firstUnpriced = prices.rows.findIndex(
      (r) => r.input_per_mtok === null && r.output_per_mtok === null,
    )
    expect(firstUnpriced).toBeGreaterThan(0)
    for (const r of prices.rows.slice(firstUnpriced)) {
      expect(r.input_per_mtok === null && r.output_per_mtok === null).toBe(true)
    }
    expect(prices.counts.priced + prices.counts.catalog_only).toBe(prices.counts.total)
    expect(prices.counts.removed).toBe(0)
    expect(prices.rows.some((r) => r.provider === 'google' && r.input_per_mtok !== null)).toBe(true)
    for (const r of prices.rows) {
      expect(r.source_url).toMatch(/^https:\/\//)
      expect(r.fetched_at).toMatch(/^2026-09-07T10:0\d:/)
    }

    expect(prices.cross_check).toMatchObject({ source_id: 'openrouter-models' })
    expect(prices.cross_check!.caveat).toContain('never source of record')
    expect(prices.changes_available).toBe(false)
  })

  it('matrix: mapped-and-priced, mapped-but-unpriced, and unmapped are three states', async () => {
    const { matrix } = await queryPrices(db, await ctx())
    expect(matrix.providers).toEqual(['openai', 'anthropic', 'google', 'xai'])
    expect(matrix.classes.map((c) => c.id)).toEqual(['flagship', 'balanced', 'economy'])
    const cell = (p: string, k: string) =>
      matrix.cells.find((c) => c.provider === p && c.class === k)!

    const xai = cell('xai', 'flagship')
    expect(xai.priced).toBe(true)
    expect(xai.row!.model_slug).toBe('grok-4.6')
    expect(xai.row!.input_per_mtok).toBe(2)
    expect(xai.row!.source_url).toBe(urlOf('xai-models-md'))
    expect(xai.gap).toBeNull()
    expect(xai.basis).toContain('Grok 4.6')

    // Mapped, no price: the SKU is right, the audited source prints no number.
    const openai = cell('openai', 'flagship')
    expect(openai.row!.model_slug).toBe('gpt-5.6-sol')
    expect(openai.priced).toBe(false)
    expect(openai.basis).toContain('Start here')
    expect(openai.gap).toContain('catalog')

    // Google has prices in the store but no vendor sentence to map against.
    const google = cell('google', 'flagship')
    expect(google.row).toBeNull()
    expect(google.gap).toContain('no recommendation text')

    const xaiEconomy = cell('xai', 'economy')
    expect(xaiEconomy.row).toBeNull()
    expect(xaiEconomy.gap).toContain('no statement')

    const anthropic = cell('anthropic', 'balanced')
    expect(anthropic.priced).toBe(true)
    expect(anthropic.row!.model_slug).toBe('claude-sonnet-5')

    // List price only — a long-context or batch sibling never fills a cell.
    for (const c of matrix.cells) if (c.row) expect([null, 'standard']).toContain(c.row.tier)
  })

  it('hiring: department mix from the current set, SpaceXAI blend surfaced on xai', async () => {
    const hiring = await queryHiring(db, await ctx())
    const [openai, anthropic, google, xai] = hiring.providers
    expect(openai!.total).toBe(65)
    expect(anthropic!.total).toBe(59)
    expect(xai!.total).toBe(42)
    expect(google!.feed).toBe('no_public_feed')

    expect(openai!.feed).toBe('ok')
    expect(openai!.departments.length).toBe(33)
    expect(openai!.departments.reduce((n, d) => n + d.count, 0)).toBe(65)
    // Sorted by count desc, then name.
    for (let i = 1; i < openai!.departments.length; i++) {
      expect(openai!.departments[i - 1]!.count).toBeGreaterThanOrEqual(
        openai!.departments[i]!.count,
      )
    }
    expect(openai!.sources).toEqual([
      expect.objectContaining({ source_id: 'openai-ashby', source_url: urlOf('openai-ashby') }),
    ])

    expect(xai!.company_names).toEqual(['SpaceXAI'])
    expect(xai!.caveat).toContain('SpaceXAI')
    expect(xai!.caveat).toContain('no aerospace or launch function')
    expect(xai!.departments[0]).toMatchObject({ department: 'Data Center' })
    expect(xai!.sources[0]!.source_url).toBe(urlOf('xai-greenhouse'))
  })

  it('coverage: every source has a snapshot, a run, and the audit caveat', async () => {
    const coverage = await queryCoverage(db, await ctx())
    expect(coverage.sources).toHaveLength(13)
    for (const s of coverage.sources) {
      expect(s.newest_snapshot!.source_url).toBe(urlOf(s.source_id))
      expect(s.newest_snapshot!.fetched_at).toMatch(/^2026-09-07T10:0\d:/)
      expect(s.snapshot_count).toBe(1)
      expect(s.last_run!.scope).toBe('survey')
    }
    const byId = Object.fromEntries(coverage.sources.map((s) => [s.source_id, s]))
    expect(byId['xai-greenhouse']).toMatchObject({ entity_count: 42, role: 'primary' })
    expect(byId['xai-greenhouse']!.last_run!.status).toBe('baseline')
    expect(byId['xai-greenhouse']!.caveat).toContain('SpaceXAI')
    expect(byId['openrouter-models']).toMatchObject({ entity_count: 0, role: 'cross-check' })
    expect(byId['openrouter-models']!.last_run!.status).toBe('ok')
    expect(byId['anthropic-greenhouse-departments']!.role).toBe('join')
    // The resolved CIK URL from the manifest, not the sources.yaml template.
    expect(byId['edgar-submissions-spcx']!.url).toBe(urlOf('edgar-submissions-spcx'))
    expect(coverage.totals.snapshots).toBe(13)
    expect(coverage.exports.find((e) => e.name === 'jobs_open')!.rows).toBe(65 + 59 + 42)
  })

  it('alerts: none after a baseline', async () => {
    const alerts = await queryAlerts(db, await ctx(), 50)
    expect(alerts.rows).toEqual([])
    expect(alerts.total).toBe(0)
  })
})

describe('after a second poll that moves prices, closes a role, and files an S-1', () => {
  beforeEach(async () => {
    await run(ALL_IDS)
    await run(
      ['xai-models-md', 'xai-greenhouse', 'edgar-fts'],
      fixtureFetcher({
        'xai-models-md': xaiRepricedAndDelisted(),
        'xai-greenhouse': xaiJobsWithout(REMOVED_JOB),
        'edgar-fts': ftsWithNewS1(),
      }),
    )
  })

  it('the newest price revision wins, with the delta against the previous one', async () => {
    const prices = await queryPrices(db, await ctx())
    const grok = prices.rows.find((r) => r.entity_key === 'model:xai:grok-4.6:standard')!
    expect(grok.input_per_mtok).toBe(2.5)
    expect(grok.delta).toMatchObject({
      change_type: 'modified',
      input_before: 2,
      input_after: 2.5,
      output_before: 6,
      output_after: 6,
      source_url: urlOf('xai-models-md'),
    })
    expect(prices.changes_available).toBe(true)

    // The matrix reads the same revision.
    const cell = prices.matrix.cells.find((c) => c.provider === 'xai' && c.class === 'flagship')!
    expect(cell.row!.input_per_mtok).toBe(2.5)
    expect(cell.row!.delta!.input_before).toBe(2)

    // A delisted SKU stays visible, struck through, from its removal.
    const delisted = prices.rows.filter((r) => r.removed)
    expect(delisted.map((r) => r.entity_key).sort()).toEqual([
      'model:xai:grok-build-0.1:long_context',
      'model:xai:grok-build-0.1:standard',
    ])
    expect(delisted[0]!.delta!.change_type).toBe('removed')
    expect(delisted[0]!.source_id).toBe('xai-models-md')
    expect(prices.counts.removed).toBe(2)
    // ...and delisted rows sort last.
    expect(prices.rows.at(-1)!.removed).toBe(true)
  })

  it('jobs are counted from the current set: a closed role stops being counted', async () => {
    const hiring = await queryHiring(db, await ctx())
    const xai = hiring.providers.find((p) => p.provider === 'xai')!
    expect(xai.total).toBe(41)
    const coverage = await queryCoverage(db, await ctx())
    expect(coverage.sources.find((s) => s.source_id === 'xai-greenhouse')!.entity_count).toBe(41)
  })

  it('the signal band counts each change on its axis inside a stated 24h window', async () => {
    const { movement, alerts, alert_count } = await queryOverview(db, await ctx())
    expect(movement.recent).toEqual({ pricing: 3, hiring: 1, sec: 1, total: 5 })
    expect(movement.total_changes).toBe(5)
    expect(movement.latest_detected_at).toMatch(/^2026-09-07T10:0\d:/)
    expect(Date.parse(movement.latest_detected_at!) - Date.parse(movement.window_from!)).toBe(
      24 * 3_600_000,
    )
    expect(movement.sources_total).toBe(13)
    expect(movement.sources_not_yet_compared).toBe(13 - 4) // xai md, xai jobs + its join, edgar-fts

    expect(alert_count).toBe(1)
    expect(alerts).toHaveLength(1)
  })

  it('an alert resolves to its cited change rows, each with provenance', async () => {
    const alerts = await queryAlerts(db, await ctx(), 50)
    expect(alerts.total).toBe(1)
    const [alert] = alerts.rows
    expect(alert).toMatchObject({ rule: 's1-floor', severity: 'critical' })
    expect(alert!.headline).toContain('S-1/A')
    expect(alert!.change_ids).toHaveLength(1)
    expect(alert!.missing_change_ids).toEqual([])
    expect(alert!.changes).toHaveLength(1)
    const [change] = alert!.changes
    expect(change).toMatchObject({
      id: alert!.change_ids[0],
      entity_key: 'filing:0001628280-26-099999',
      entity_type: 'filing',
      change_type: 'added',
      source_url: urlOf('edgar-fts'),
    })
    expect(change!.summary).toContain('S-1/A')
    expect(change!.summary).toContain('2026-09-01')
    expect(change!.diff).toEqual([])
    expect(alert!.source_url).toBe(urlOf('edgar-fts'))
  })

  it('the permalink resolves the same alert with every field of the cited row', async () => {
    const { rows } = await queryAlerts(db, await ctx(), 1)
    const detail = await queryAlert(db, await ctx(), rows[0]!.id)
    expect(detail).not.toBeNull()
    expect(detail!.alert).toMatchObject({ id: rows[0]!.id, rule: 's1-floor', severity: 'critical' })
    const [change] = detail!.alert.changes
    expect(change!.id).toBe(rows[0]!.change_ids[0])
    // An added row: every field is ∅ → value, and the diff stays empty.
    expect(change!.diff).toEqual([])
    expect(change!.fields.length).toBeGreaterThan(0)
    for (const f of change!.fields) expect(f.before).toBeNull()
    expect(change!.fields.find((f) => f.field === 'form')!.after).toBe('S-1/A')
    expect(change!.source_url).toBe(urlOf('edgar-fts'))
    expect(await queryAlert(db, await ctx(), 'f'.repeat(64))).toBeNull()
  })

  it('the coverage panel shows how the last poll of each source ended', async () => {
    const coverage = await queryCoverage(db, await ctx())
    const byId = Object.fromEntries(coverage.sources.map((s) => [s.source_id, s]))
    expect(byId['xai-models-md']!.last_run!.status).toBe('ok')
    expect(byId['xai-models-md']!.snapshot_count).toBe(2)
    expect(byId['openai-ashby']!.last_run!.status).toBe('baseline')
    expect(byId['openai-ashby']!.snapshot_count).toBe(1)
  })
})

describe('the stated window holds when changes span several axes', () => {
  it('anchors to the newest detection, never to the reader’s clock', async () => {
    const src = urlOf('xai-models-md')
    const change = (id: string, type: 'model' | 'job', at: string) => ({
      id: contentHashOfText(id),
      entity_key: `${type}:xai:${id}`,
      entity_type: type,
      provider: 'xai',
      change_type: 'added',
      before_hash: null,
      after_hash: contentHashOfText(id),
      before_json: null,
      after_json: JSON.stringify({ id }),
      detected_at: at,
      source_url: src,
      fetched_at: at,
    })
    await insertRows(db, 'changes', [
      change('a', 'model', '2026-08-25T22:16:44Z'),
      change('b', 'job', '2026-08-26T16:24:42Z'), // newest — anchors the window
      change('c', 'job', '2026-08-26T10:18:56Z'),
      change('d', 'model', '2026-08-25T16:00:00Z'), // 24h24m before — outside
    ])
    const { movement } = await queryOverview(db, await ctx())
    expect(movement.latest_detected_at).toBe('2026-08-26T16:24:42Z')
    expect(movement.window_from).toBe('2026-08-25T16:24:42.000Z')
    expect(movement.recent).toEqual({ pricing: 1, hiring: 2, sec: 0, total: 3 })
    expect(movement.total_changes).toBe(4)
  })
})

describe('the like-for-like map is checkable', () => {
  it('every class quote is grepped back out of the fixture it cites', () => {
    // A vendor rewriting its recommendation fails here instead of aging
    // silently into a claim nobody can source.
    const flatten = (md: string) => md.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    for (const entry of MODEL_CLASS_MAP) {
      const fixture = manifest.fixtures.find((f) => f.source_id === entry.basis_source_id)
      expect(fixture, entry.basis_source_id).toBeDefined()
      expect(flatten(fixtureText(fixture!.path))).toContain(entry.basis)
    }
  })

  it('fieldDiff reports only the scalar fields that moved', () => {
    expect(
      fieldDiff({ a: 1, b: 'x', c: null, d: [1] }, { a: 2, b: 'x', c: 'now', d: [1] }),
    ).toEqual([
      { field: 'a', before: '1', after: '2' },
      { field: 'c', before: null, after: 'now' },
    ])
    expect(fieldDiff(null, { a: 1 })).toEqual([])
  })
})

describe('the ticker/alert split', () => {
  const src = 'https://boards-api.greenhouse.io/v1/boards/xai/jobs'
  const job = (n: number, at: string) => {
    const after = JSON.stringify({ title: `Role ${n}`, department: 'Sales' })
    return {
      id: contentHash({ n, at }),
      entity_key: `job:xai:${n}`,
      entity_type: 'job',
      provider: 'xai',
      change_type: 'added',
      before_hash: null,
      after_hash: contentHashOfText(after),
      before_json: null,
      after_json: after,
      detected_at: at,
      source_url: src,
      fetched_at: at,
    }
  }
  const alertRow = (severity: 'info' | 'notable' | 'critical', changeId: string, at: string) =>
    AlertRow.parse({
      id: contentHash({ change_ids: [changeId], headline: `${severity} ${at}` }),
      severity,
      headline: `${severity} ${at}`,
      explanation: 'x',
      change_ids: JSON.stringify([changeId]),
      rule: 'agent-judge',
      created_at: at,
      source_url: src,
      fetched_at: at,
    })

  const T = (h: number) =>
    `2026-09-0${1 + Math.floor(h / 24)}T${String(h % 24).padStart(2, '0')}:00:00Z`

  beforeEach(async () => {
    const changes = Array.from({ length: 12 }, (_, i) => job(i, T(i)))
    await insertRows(db, 'changes', changes)
    // 9 info, 2 notable, 1 critical — the live store's shape in miniature.
    const severities = (i: number) => (i % 4 === 3 ? (i === 11 ? 'critical' : 'notable') : 'info')
    await insertRows(
      db,
      'alerts',
      changes.map((c, i) => alertRow(severities(i), c.id, c.detected_at)),
    )
  })

  it('queryAlerts filters by tier and reports the tier’s own total', async () => {
    const all = await queryAlerts(db, await ctx(), 50)
    expect(all.tier).toBe('all')
    expect(all.total).toBe(12)

    const alerts = await queryAlerts(db, await ctx(), 2, 'alert')
    expect(alerts.tier).toBe('alert')
    expect(alerts.total).toBe(3)
    expect(alerts.rows).toHaveLength(2)
    expect(alerts.rows.map((r) => r.severity)).toEqual(['critical', 'notable'])
    for (const r of alerts.rows) expect(r.changes).toHaveLength(1)

    const ticker = await queryAlerts(db, await ctx(), 50, 'ticker')
    expect(ticker.total).toBe(9)
    expect(ticker.rows.every((r) => r.severity === 'info')).toBe(true)
    // Newest first within the tier.
    expect(ticker.rows[0]!.created_at > ticker.rows.at(-1)!.created_at).toBe(true)
  })

  it('the overview leads with the alert tier and carries the ticker beside it', async () => {
    const overview = await queryOverview(db, await ctx())
    expect(overview.alert_count).toBe(3)
    expect(overview.alerts.map((a) => a.severity)).toEqual(['critical', 'notable', 'notable'])
    expect(overview.ticker_count).toBe(9)
    expect(overview.ticker).toHaveLength(8) // OVERVIEW_TICKER caps the band; the count says 9
    expect(overview.ticker.every((a) => a.severity === 'info')).toBe(true)
  })

  it('enumerates every permalink for the sitemap with its own tier and date', async () => {
    const links = await alertPermalinks(db)
    expect(links).toHaveLength(12)
    expect(links.filter((l) => l.tier === 'alert')).toHaveLength(3)
    expect(links.filter((l) => l.tier === 'ticker')).toHaveLength(9)
    expect(links[0]!.created_at).toBe(T(11))
    expect(await alertPermalinks(db, 3)).toHaveLength(3)
  })

  it('fieldTable lists every field of either side; fieldDiff is its changed subset', () => {
    expect(fieldTable({ a: 1, b: 'x' }, { a: 2, b: 'x', c: true })).toEqual([
      { field: 'a', before: '1', after: '2' },
      { field: 'b', before: 'x', after: 'x' },
      { field: 'c', before: null, after: 'true' },
    ])
    expect(fieldTable(null, { a: 1 })).toEqual([{ field: 'a', before: null, after: '1' }])
    expect(fieldTable({ a: 1 }, null)).toEqual([{ field: 'a', before: '1', after: null }])
  })
})
