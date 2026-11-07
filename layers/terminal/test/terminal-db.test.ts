import { env } from 'cloudflare:test'
import { like } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { contentHashOfText } from '../server/pipeline/contracts'
import type { FetchOutcome, SourceFetcher } from '../server/pipeline/fetch'
import { runRefresh, type RawStore, type RefreshDeps } from '../server/pipeline/refresh'
import { includeSources } from '../server/pipeline/sources'
import { AlertRow, contentHash } from '../server/pipeline/contracts'
import { insertRows } from '../server/pipeline/store'
import { terminalStamps } from '../server/utils/terminal-cache'
import { MODEL_CLASS_MAP, NO_ROW_GAP } from '../server/utils/terminal-classes'
import { ENTITY_AXIS } from '../shared/utils/terminal-labs'
import type { PriceRowView } from '../shared/utils/terminal-types'
import {
  AXIS_OF,
  alertPermalinks,
  buildMatrix,
  parseAlertCursor,
  queryAlert,
  queryAlerts,
  queryContext,
  queryCoverage,
  queryHiring,
  queryIncidents,
  queryOverview,
  queryPrices,
  sourceReads,
} from '../server/utils/terminal-db'
import { fieldDiff, fieldTable } from '../server/utils/terminal-json'
import { fixtureText, manifest } from './pipeline/fixtures'

// The UI's query layer against a real D1, seeded the way production is: the
// committed fixtures pushed through runRefresh (fetch → parse → normalize →
// diff → insertRows), so every row carries live provenance and every value
// was read from a fixture rather than typed here. The golden assertions:
// jobs are counted from the current set, the newest
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

const T0 = Date.parse('2026-09-07T10:00:00Z')
let tick = T0
const now = () => new Date((tick += 1000))
const deps = (fetcher: SourceFetcher): RefreshDeps => ({ db, raw, fetcher, sourcesYaml, now })
const run = (ids: readonly string[], fetcher = fixtureFetcher()) =>
  runRefresh(deps(fetcher), 'survey', ids)

const FIXED_NOW = () => new Date('2026-09-07T12:00:00Z')
const ctx = async () => queryContext(sourcesYaml, (await terminalStamps(db)).poll, FIXED_NOW)

// ── Fixture edits for the change scenarios ──────────────────────────────────

const REMOVED_JOB = 5090171007 // AI Tutor - Arabic, xai board
const xaiJobsWithout = (id: number) => {
  const board = JSON.parse(fixtureText('fixtures/hiring/xai-greenhouse.json')) as {
    jobs: { id: number }[]
  }
  return JSON.stringify({ ...board, jobs: board.jobs.filter((j) => j.id !== id) })
}

const XAI_PRICE_LINE = '| grok-4.7 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |'
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
  // Every test starts its clock at T0: the tables are wiped below, and a
  // clock carried across tests pushed later ones past the 10:0x assertions.
  tick = T0
  for (const table of [
    schema.sourceRuns,
    schema.sourceStats,
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
      recent: { pricing: 0, hiring: 0, sec: 0, incidents: 0, disclosures: 0, total: 0 },
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

  it('prices: twenty-seven matrix cells, each with a stated gap and no invented number', async () => {
    const prices = await queryPrices(db, await ctx())
    expect(prices.rows).toEqual([])
    expect(prices.matrix.cells).toHaveLength(27)
    for (const cell of prices.matrix.cells) {
      expect(cell.priced).toBe(false)
      expect(cell.row).toBeNull()
      expect(cell.gap).toBeTruthy()
    }
    expect(prices.changes_available).toBe(false)
    expect(prices.cross_check).toBeNull()
  })

  it('hiring: four labs are stated cuts; the other five say no rows, not zero roles', async () => {
    const hiring = await queryHiring(db, await ctx())
    expect(hiring.providers.map((p) => p.provider)).toEqual([
      'openai',
      'anthropic',
      'google',
      'xai',
      'meta',
      'mistral',
      'deepseek',
      'alibaba',
      'moonshot',
    ])
    const meta = hiring.providers[4]!
    expect(meta.feed).toBe('no_public_feed')
    expect(meta.reason).toContain('metacareers.com')
    expect(
      hiring.providers.filter((p) => p.feed === 'no_public_feed').map((p) => p.provider),
    ).toEqual(['meta', 'deepseek', 'alibaba', 'moonshot'])
    for (const p of hiring.providers.filter((p) => p.feed !== 'no_public_feed')) {
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
    expect(coverage.cuts.map((c) => c.id)).toContain('meta-hiring')
    expect(coverage.exports.map((e) => e.name)).toEqual([
      'snapshots',
      'prices_latest',
      'jobs_open',
      'incidents',
      'disclosures',
      'disclosure_timelines',
      'filers',
      'revenue_facts',
      'prospectus_statements',
      'prospectus_commitments',
      'prospectus_concentration',
      'prospectus_shares',
      'prospectus_risk_factors',
      'changes',
      'archived_prices',
      'archived_hiring',
      'archive_captures',
      'alerts',
      'claim_readings',
      'claim_verdicts',
      'track_record_candidates',
      'track_record_verdicts',
      'recipe_observations',
      'filed_facts',
      'exposure_quarters',
      'source_runs',
      'entity_securities',
      'entity_identifiers',
    ])
  })

  it('incidents: three labs are stated cuts; the other six say no rows, not zero incidents', async () => {
    const incidents = await queryIncidents(db, await ctx())
    expect(incidents.providers.map((p) => p.provider)).toEqual([
      'openai',
      'anthropic',
      'google',
      'xai',
      'meta',
      'mistral',
      'deepseek',
      'alibaba',
      'moonshot',
    ])
    const meta = incidents.providers[4]!
    expect(meta.feed).toBe('no_public_feed')
    expect(meta.reason).toContain('current state')
    expect(
      incidents.providers.filter((p) => p.feed === 'no_public_feed').map((p) => p.provider),
    ).toEqual(['meta', 'alibaba', 'moonshot'])
    for (const p of incidents.providers.filter((p) => p.feed !== 'no_public_feed')) {
      expect(p.feed).toBe('no_rows')
      expect(p.last_window).toBe(0)
      expect(p.open).toEqual([])
      expect(p.coverage_from).toBeNull()
    }
    // No feed fetched: the window anchors on the query clock and says so.
    expect(incidents.window_to).toBe('2026-09-07T12:00:00.000Z')
    expect(incidents.incidents).toEqual([])
    expect(incidents.providers[2]!.caveat).toContain('Gemini')
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
    expect(movement.sources_total).toBe(45)
    // Every source has exactly one snapshot => nothing could have been
    // diffed. That is a different sentence from "nothing changed".
    expect(movement.sources_not_yet_compared).toBe(45)
    expect(latest_fetched_at).toMatch(/^2026-09-07T10:0\d:/)
  })

  it('prices: fixture values, live provenance, priced rows first', async () => {
    const prices = await queryPrices(db, await ctx())
    const grok = prices.rows.find((r) => r.entity_key === 'model:xai:grok-4.7:standard')!
    // "| grok-4.7 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |"
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
    const sonnet = prices.rows.filter((r) => r.entity_key === 'model:anthropic:claude-sonnet-5-5')
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
    expect(matrix.providers).toEqual([
      'openai',
      'anthropic',
      'google',
      'xai',
      'meta',
      'mistral',
      'deepseek',
      'alibaba',
      'moonshot',
    ])
    expect(matrix.classes.map((c) => c.id)).toEqual(['flagship', 'balanced', 'economy'])
    const cell = (p: string, k: string) =>
      matrix.cells.find((c) => c.provider === p && c.class === k)!

    const xai = cell('xai', 'flagship')
    expect(xai.priced).toBe(true)
    expect(xai.row!.model_slug).toBe('grok-4.7')
    expect(xai.row!.input_per_mtok).toBe(2)
    expect(xai.row!.source_url).toBe(urlOf('xai-models-md'))
    expect(xai.gap).toBeNull()
    expect(xai.basis).toContain('Grok 4.7')
    // The poll re-read the sentence off the page and said so.
    expect(xai.basis_current).toBe(true)
    expect(xai.basis_checked_at).toBe(xai.row!.fetched_at)
    expect(xai.basis_note).toBeNull()

    // The catalog row (models.md, no prices) and the pricing row (pricing.md)
    // share one key; the cell reads the priced one and cites both pages.
    const openai = cell('openai', 'flagship')
    expect(openai.row!.model_slug).toBe('gpt-6-astra')
    expect(openai.priced).toBe(true)
    expect(openai.row!.input_per_mtok).toBe(10)
    expect(openai.row!.output_per_mtok).toBe(50)
    expect(openai.row!.source_url).toBe(urlOf('openai-pricing-md'))
    expect(openai.row!.also_listed_by).toEqual(['openai-models-md'])
    expect(openai.basis).toContain('GPT-6 Astra')
    // The sentence lives on the catalog page, and that is where it was checked.
    expect(openai.basis_source_id).toBe('openai-models-md')
    expect(openai.basis_current).toBe(true)
    expect(openai.gap).toBeNull()

    // Google's sentence is on its models page, and the pricing page prices the
    // SKU it names: the current row of a promo, not the scheduled one.
    const google = cell('google', 'flagship')
    expect(google.basis_source_id).toBe('google-models-md')
    expect(google.basis_current).toBe(true)
    expect(google.row!.model_slug).toBe('gemini-4-argon')
    expect(google.priced).toBe(true)
    expect(google.row!.input_per_mtok).toBe(2)
    expect(google.row!.output_per_mtok).toBe(10)
    expect(google.row!.effective_until).toBe('2026-12-01')
    expect(google.gap).toBeNull()

    const googleEconomy = cell('google', 'economy')
    expect(googleEconomy.row!.model_slug).toBe('gemini-3.5-flash-lite')
    expect(googleEconomy.priced).toBe(true)
    expect(googleEconomy.row!.source_url).toBe(urlOf('google-pricing-html'))

    // Google publishes no current-generation price-performance sentence.
    const googleBalanced = cell('google', 'balanced')
    expect(googleBalanced.basis).toBeNull()
    expect(googleBalanced.gap).toContain('Gemini 2.5 Flash')

    const xaiEconomy = cell('xai', 'economy')
    expect(xaiEconomy.row).toBeNull()
    expect(xaiEconomy.gap).toContain('cost-sensitive work')

    const anthropic = cell('anthropic', 'balanced')
    expect(anthropic.priced).toBe(true)
    expect(anthropic.row!.model_slug).toBe('claude-sonnet-5-5')

    // Meta's catalog (no prices) and price list share a key per model id, as OpenAI's do.
    const meta = cell('meta', 'flagship')
    expect(meta.priced).toBe(true)
    expect(meta.row!.model_slug).toBe('muse-wonder-1.0')
    expect(meta.row!.input_per_mtok).toBe(4)
    expect(meta.row!.output_per_mtok).toBe(20)
    expect(meta.row!.source_url).toBe(urlOf('meta-pricing-md'))
    expect(meta.row!.also_listed_by).toEqual(['meta-models-md'])
    expect(meta.basis_source_id).toBe('meta-models-md')
    expect(meta.basis_current).toBe(true)
    expect(cell('meta', 'economy').row!.model_slug).toBe('muse-spark-1.3')
    expect(cell('meta', 'balanced').gap).toContain('names no middle tier')

    // Mistral prints no tier sentence: every cell is a stated gap, never a guess.
    for (const k of ['flagship', 'balanced', 'economy']) {
      expect(cell('mistral', k)).toMatchObject({ row: null, priced: false })
    }
    expect(cell('mistral', 'flagship').gap).toContain('name no flagship')

    // DeepSeek prints prices and no tier sentence: three stated gaps.
    for (const k of ['flagship', 'balanced', 'economy']) {
      expect(cell('deepseek', k)).toMatchObject({ row: null, priced: false, basis: null })
    }
    // Alibaba's sentences are on its recommended-models page; its price list prices them.
    const qwen = cell('alibaba', 'flagship')
    expect(qwen).toMatchObject({ priced: true, basis_source_id: 'alibaba-models-html' })
    expect(qwen.row).toMatchObject({
      model_slug: 'qwen3.8-max',
      input_per_mtok: 2,
      output_per_mtok: 6,
    })
    expect(qwen.row!.source_url).toBe(urlOf('alibaba-pricing-html'))
    expect(cell('alibaba', 'balanced').row!.model_slug).toBe('qwen3.7-plus')
    expect(cell('alibaba', 'economy').row!.model_slug).toBe('qwen3.8-flash')
    // Moonshot names a flagship, but the served page prints no price: mapped, unpriced.
    const kimi = cell('moonshot', 'flagship')
    expect(kimi).toMatchObject({ priced: false, basis_current: true })
    expect(kimi.row!.model_slug).toBe('kimi-k3.1-pro')
    expect(kimi.gap).toContain('draws its price tables in the browser')

    // List price only — a long-context or batch sibling never fills a cell.
    for (const c of matrix.cells) if (c.row) expect([null, 'standard']).toContain(c.row.tier)

    // The same mapping with its SKU unstored is the middle state: mapped, unpriced.
    await db
      .delete(schema.entities)
      .where(like(schema.entities.entity_key, 'model:google:gemini-4-argon%'))
    const after = await queryPrices(db, await ctx())
    const unpriced = after.matrix.cells.find(
      (c) => c.provider === 'google' && c.class === 'flagship',
    )!
    expect(unpriced.basis_source_id).toBe('google-models-md')
    expect(unpriced.row).toBeNull()
    expect(unpriced.gap).toBe(NO_ROW_GAP)
  })

  it('hiring: department mix from the current set, SpaceXAI blend surfaced on xai', async () => {
    const hiring = await queryHiring(db, await ctx())
    const [openai, anthropic, google, xai] = hiring.providers
    expect(openai!.total).toBe(65)
    expect(anthropic!.total).toBe(59)
    expect(xai!.total).toBe(42)
    // DeepMind's roles only; the feed's Google and YouTube roles never land.
    expect(google!.feed).toBe('ok')
    expect(google!.total).toBe(27)
    expect(google!.company_names).toEqual(['DeepMind'])

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

  it('hiring and overview: cite the last read of a board, not its last changed role', async () => {
    const xaiSource = async () =>
      (await queryHiring(db, await ctx())).providers.find((p) => p.provider === 'xai')!.sources[0]!
    const baseline = await xaiSource()

    await run(['xai-greenhouse'])
    const newest = (await sourceReads(db)).stamps.get('xai-greenhouse')!.newest.fetched_at
    expect(Date.parse(newest)).toBeGreaterThan(Date.parse(baseline.fetched_at))
    expect((await xaiSource()).fetched_at).toBe(newest)
    expect((await queryOverview(db, await ctx())).latest_fetched_at).toBe(newest)

    // An empty board is refused as a mass removal: stored, not read.
    await run(['xai-greenhouse'], fixtureFetcher({ 'xai-greenhouse': '{"jobs":[]}' }))
    const refused = (await sourceReads(db)).stamps.get('xai-greenhouse')!.newest.fetched_at
    expect(refused).not.toBe(newest)
    expect((await xaiSource()).fetched_at).toBe(newest)
    // The departments side page was read in the same tick, so "last checked"
    // may move to it, but never to the refused board.
    expect((await queryOverview(db, await ctx())).latest_fetched_at).not.toBe(refused)
  })

  it('coverage: every source has a snapshot, a run, and the audit caveat', async () => {
    const coverage = await queryCoverage(db, await ctx())
    expect(coverage.sources).toHaveLength(45)
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
    expect(coverage.totals.snapshots).toBe(45)
    expect(coverage.exports.find((e) => e.name === 'jobs_open')!.rows).toBe(65 + 59 + 42 + 19 + 27)
    expect(coverage.exports.find((e) => e.name === 'incidents')!.rows).toBe(
      25 + 25 + 1 + 50 + 97 + 28,
    )
    expect(byId['google-cloud-status']).toMatchObject({ entity_count: 1, role: 'status' })
    expect(byId['google-cloud-status']!.last_run!.detail).toBe(
      '1 entities; 5 incidents skipped: no Gemini / Vertex AI product',
    )
  })

  it('incidents: windows anchor on the newest status fetch and each card says where its history begins', async () => {
    const incidents = await queryIncidents(db, await ctx())
    // The anchor is the fetch, not the reader's clock: the fixture feeds
    // were read on 2026-09-08 but this store fetched them "on" 2026-09-07.
    expect(incidents.window_to).toMatch(/^2026-09-07T10:0\d:/)
    expect(incidents).toMatchObject({ window_days: 30, history_days: 90 })
    const byProvider = Object.fromEntries(incidents.providers.map((p) => [p.provider, p]))

    // OpenAI: 25 incidents 2026-08-05 → 2026-09-08; the one at 14:32Z on the
    // 8th starts AFTER this store's anchor and is outside every window.
    const openai = byProvider.openai!
    expect(openai.feed).toBe('ok')
    expect(openai.coverage_from).toBe('2026-08-05T16:55:54Z')
    expect(openai.last_window + openai.prior_window).toBeLessThanOrEqual(25)
    expect(openai.open.map((i) => i.incident_id)).toEqual(['01M20PYYYGRT9303VHAPA7YNT2'])
    expect(openai.sources[0]).toMatchObject({
      source_id: 'openai-status',
      source_url: urlOf('openai-status'),
    })

    // Anthropic: the Atom feed's 25 entries begin 2026-09-03, inside the
    // newest window, so the prior window is empty, not low. The feed
    // publishes no impact, and none is invented.
    const anthropic = byProvider.anthropic!
    expect(anthropic.coverage_from).toBe('2026-09-03T13:26:00.000Z')
    expect(anthropic.last_window).toBeGreaterThan(0)
    expect(anthropic.prior_window).toBe(0)
    expect(anthropic.open).toEqual([])
    const anthropicRows = incidents.incidents.filter((i) => i.provider === 'anthropic')
    expect(anthropicRows.length).toBeGreaterThan(0)
    expect(anthropicRows.every((i) => i.impact === null)).toBe(true)

    // Google: the one Gemini incident is from February — held, but outside 90 days.
    const google = byProvider.google!
    expect(google).toMatchObject({ feed: 'ok', last_window: 0, prior_window: 0 })
    expect(google.coverage_from).toBe('2026-02-27T12:37:00+00:00')
    expect(incidents.incidents.some((i) => i.provider === 'google')).toBe(false)

    // Newest first, every row with the fetch's provenance and the vendor's link.
    const starts = incidents.incidents.map((i) => i.started_at)
    expect(starts).toEqual([...starts].sort().reverse())
    for (const i of incidents.incidents) {
      expect(i.source_url).toBe(urlOf(`${i.provider}-status`))
      expect(i.fetched_at).toMatch(/^2026-09-07T10:0\d:/)
      expect(i.incident_url).toMatch(/^https:\/\/status\./)
    }
    // xAI: the RSS history folds per-component items into one row per incident.
    expect(byProvider.xai!.feed).toBe('ok')
    expect(byProvider.xai!.coverage_from).toBe('2026-08-06T19:59:13Z')
    expect(byProvider.xai!.caveat).toContain('Cursor')
  })

  it('incidents: each lab counts back from its own feed’s last read, never a failed fetch', async () => {
    const baseline = await queryIncidents(db, await ctx())
    const xaiRead = baseline.providers.find((p) => p.provider === 'xai')!.window_to!
    await run(['openai-status'])
    await run(['xai-status'], fixtureFetcher({ 'xai-status': 'not a feed' }))
    const failed = (await sourceReads(db)).stamps.get('xai-status')!.newest.fetched_at
    expect(Date.parse(failed)).toBeGreaterThan(Date.parse(xaiRead))

    const incidents = await queryIncidents(db, await ctx())
    const byProvider = Object.fromEntries(incidents.providers.map((p) => [p.provider, p]))
    const openaiRead = (await sourceReads(db)).stamps.get('openai-status')!.newest.fetched_at
    // The freshest read anchors the list; the failed fetch anchors nothing.
    expect(incidents.window_to).toBe(openaiRead)
    expect(byProvider.openai!.window_to).toBe(openaiRead)
    expect(byProvider.xai!.window_to).toBe(xaiRead)
    expect(byProvider.xai!.sources[0]!.fetched_at).toBe(xaiRead)
    expect(Date.parse(byProvider.anthropic!.window_to!)).toBeLessThan(Date.parse(openaiRead))
    expect(byProvider.meta!.window_to).toBeNull()
  })

  it('alerts: none after a baseline', async () => {
    const alerts = await queryAlerts(db, await ctx(), 50)
    expect(alerts.rows).toEqual([])
    expect(alerts.total).toBe(0)
  })

  it('matrix: an unchanged repoll moves the basis check to that poll', async () => {
    const before = (await queryPrices(db, await ctx())).matrix.cells.find(
      (c) => c.provider === 'xai' && c.class === 'flagship',
    )!
    await run(['xai-models-md'])
    const after = (await queryPrices(db, await ctx())).matrix.cells.find(
      (c) => c.provider === 'xai' && c.class === 'flagship',
    )!
    const newest = (await sourceReads(db)).stamps.get('xai-models-md')!.newest.fetched_at
    expect(after.basis_current).toBe(true)
    expect(after.basis_checked_at! > before.basis_checked_at!).toBe(true)
    expect(after.basis_checked_at).toBe(newest)
  })

  it('prices: a current row is dated to the last read that showed it, not to a failed one', async () => {
    const grok = async () =>
      (await queryPrices(db, await ctx())).rows.find(
        (r) => r.source_id === 'xai-models-md' && r.model_slug === 'grok-4.7' && !r.removed,
      )!
    // Read once: nothing later than the row's own fetch.
    expect((await grok()).checked_at).toBeNull()

    await run(['xai-models-md'])
    const read = await grok()
    expect(Date.parse(read.checked_at!)).toBeGreaterThan(Date.parse(read.fetched_at))
    expect(read.checked_at).toBe(
      (await sourceReads(db)).stamps.get('xai-models-md')!.newest.fetched_at,
    )

    // A fetch that stores its bytes but cannot be read confirms nothing.
    await run(['xai-models-md'], fixtureFetcher({ 'xai-models-md': 'not a model list' }))
    const failed = await grok()
    expect((await sourceReads(db)).stamps.get('xai-models-md')!.newest.fetched_at).not.toBe(
      read.checked_at,
    )
    expect(failed.checked_at).toBe(read.checked_at)
    expect(failed.fetched_at).toBe(read.fetched_at)
  })

  it('matrix: a vendor rewriting its recommendation puts the cell under review, price intact', async () => {
    const md = fixtureText('fixtures/pricing/xai-models.md')
    const rewritten = md.replace('use Grok 4.7. It is', 'use Grok 4.8. It is')
    expect(rewritten).not.toBe(md)
    await run(['xai-models-md'], fixtureFetcher({ 'xai-models-md': rewritten }))

    const { matrix } = await queryPrices(db, await ctx())
    const xai = matrix.cells.find((c) => c.provider === 'xai' && c.class === 'flagship')!
    // The stored price for the mapped SKU is still the stored price.
    expect(xai.priced).toBe(true)
    expect(xai.row!.model_slug).toBe('grok-4.7')
    expect(xai.row!.input_per_mtok).toBe(2)
    // What changed is the claim that this SKU still answers the column.
    expect(xai.basis_current).toBe(false)
    expect(xai.basis_note).toContain('under review')
    expect(xai.basis_checked_at).toMatch(/^2026-09-07T10:0\d:/)
    // Every other mapped cell is untouched.
    for (const c of matrix.cells) {
      if (c.basis && !(c.provider === 'xai' && c.class === 'flagship')) {
        expect(c.basis_current).toBe(true)
      }
    }
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
    const grok = prices.rows.find((r) => r.entity_key === 'model:xai:grok-4.7:standard')!
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
    expect(movement.recent).toEqual({
      pricing: 3,
      hiring: 1,
      sec: 1,
      incidents: 0,
      disclosures: 0,
      total: 5,
    })
    expect(movement.total_changes).toBe(5)
    expect(movement.latest_detected_at).toMatch(/^2026-09-07T10:0\d:/)
    expect(Date.parse(movement.latest_detected_at!) - Date.parse(movement.window_from!)).toBe(
      24 * 3_600_000,
    )
    expect(movement.sources_total).toBe(45)
    expect(movement.sources_not_yet_compared).toBe(45 - 4) // xai md, xai jobs + its join, edgar-fts

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
    const change = (id: string, type: 'model' | 'job' | 'offering' | 'statement', at: string) => ({
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
      // Prospectus rows sit on the SEC bucket; the band once counted them in
      // the total and on no axis.
      change('e', 'offering', '2026-08-26T09:00:00Z'),
      change('f', 'statement', '2026-08-26T09:30:00Z'),
    ])
    const { movement } = await queryOverview(db, await ctx())
    expect(movement.latest_detected_at).toBe('2026-08-26T16:24:42Z')
    expect(movement.window_from).toBe('2026-08-25T16:24:42.000Z')
    expect(movement.recent).toEqual({
      pricing: 1,
      hiring: 2,
      sec: 2,
      incidents: 0,
      disclosures: 0,
      total: 5,
    })
    expect(movement.total_changes).toBe(6)
  })

  it('buckets every entity type that has an axis, so the total is the sum of the axes', () => {
    for (const [type, axis] of Object.entries(ENTITY_AXIS)) {
      if (axis === 'demand') expect(AXIS_OF[type]).toBeUndefined()
      else expect(AXIS_OF[type], type).toBeDefined()
    }
  })
})

describe('the matrix prices what a model costs at the query instant', () => {
  it('passes over a scheduled price until its start date', () => {
    const entry = MODEL_CLASS_MAP.find((e) => e.class === 'flagship')!
    const row = (over: Partial<PriceRowView>): PriceRowView => ({
      entity_key: `model:${entry.provider}:${entry.model_slug}:standard`,
      source_id: 'pricing',
      provider: entry.provider,
      model_slug: entry.model_slug,
      tier: 'standard',
      context_window: null,
      context_window_source: null,
      input_per_mtok: 2,
      cached_input_per_mtok: null,
      output_per_mtok: 10,
      effective_from: null,
      effective_until: null,
      notes: null,
      removed: false,
      delta: null,
      also_listed_by: [],
      revisions: 1,
      spark: null,
      source_url: 'https://example.com/pricing',
      fetched_at: '2026-11-01T00:00:00.000Z',
      checked_at: null,
      ...over,
    })
    // Richer and newer, so preferRow alone would pick it.
    const scheduled = row({
      entity_key: `model:${entry.provider}:${entry.model_slug}:standard@2027-01-01`,
      input_per_mtok: 1,
      cached_input_per_mtok: 0.1,
      effective_from: '2027-01-01',
      fetched_at: '2026-11-05T00:00:00.000Z',
    })
    const cellAt = (at: string | null) =>
      buildMatrix([row({}), scheduled], new Map(), MODEL_CLASS_MAP, at).cells.find(
        (c) => c.provider === entry.provider && c.class === 'flagship',
      )!
    expect(cellAt('2026-11-07T00:00:00.000Z').row!.input_per_mtok).toBe(2)
    expect(cellAt('2027-01-02T00:00:00.000Z').row!.input_per_mtok).toBe(1)
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

    const critical = await queryAlerts(db, await ctx(), 50, 'critical')
    expect(critical.tier).toBe('critical')
    expect(critical.total).toBe(1)
    expect(critical.rows.map((r) => r.severity)).toEqual(['critical'])

    const minor = await queryAlerts(db, await ctx(), 50, 'info')
    expect(minor.total).toBe(9)
    expect(minor.rows.every((r) => r.severity === 'info')).toBe(true)
    // Newest first within the tier.
    expect(minor.rows[0]!.created_at > minor.rows.at(-1)!.created_at).toBe(true)
  })

  it('queryAlerts filters by the lab and topic of the cited rows', async () => {
    const price = {
      ...job(99, T(20)),
      id: 'price-change',
      entity_key: 'model:anthropic:haiku',
      entity_type: 'model',
      provider: 'anthropic',
    }
    await insertRows(db, 'changes', [price])
    const both = { ...alertRow('critical', price.id, T(21)), id: 'both-labs' }
    // One alert citing an xAI job and an Anthropic price: found under either lab.
    both.change_ids = JSON.stringify([price.id, job(0, T(0)).id])
    await insertRows(db, 'alerts', [alertRow('notable', price.id, T(20)), both])

    const anthropic = await queryAlerts(db, await ctx(), 50, 'all', { lab: 'anthropic' })
    expect(anthropic.total).toBe(2)
    expect(anthropic.rows.map((r) => r.id)).toContain('both-labs')

    const xai = await queryAlerts(db, await ctx(), 50, 'all', { lab: 'xai' })
    expect(xai.total).toBe(13)

    const pricing = await queryAlerts(db, await ctx(), 50, 'alert', { topic: 'pricing' })
    expect(pricing.total).toBe(2)
    const hiringCritical = await queryAlerts(db, await ctx(), 50, 'critical', {
      lab: 'xai',
      topic: 'hiring',
    })
    expect(hiringCritical.rows.map((r) => r.id).sort()).toEqual(
      ['both-labs', alertRow('critical', job(11, T(11)).id, T(11)).id].sort(),
    )
    expect((await queryAlerts(db, await ctx(), 50, 'all', { lab: 'meta' })).total).toBe(0)
  })

  it('queryAlerts pages by cursor through every alert, newest first, without repeats', async () => {
    const seen: string[] = []
    let page = await queryAlerts(db, await ctx(), 5)
    expect(page.total).toBe(12)
    seen.push(...page.rows.map((r) => r.id))
    while (page.next_cursor) {
      const cursor = parseAlertCursor(page.next_cursor)!
      page = await queryAlerts(db, await ctx(), 5, 'all', { cursor })
      expect(page.total).toBe(12)
      seen.push(...page.rows.map((r) => r.id))
    }
    expect(seen).toHaveLength(12)
    expect(new Set(seen).size).toBe(12)
    expect(page.rows).toHaveLength(2)

    const exact = await queryAlerts(db, await ctx(), 12)
    expect(exact.next_cursor).toBeNull()
  })

  it('the overview leads with the alert tier and carries the minor changes beside it', async () => {
    const overview = await queryOverview(db, await ctx())
    expect(overview.alert_count).toBe(3)
    expect(overview.alerts.map((a) => a.severity)).toEqual(['critical', 'notable', 'notable'])
    expect(overview.info_count).toBe(9)
    expect(overview.info).toHaveLength(8) // OVERVIEW_INFO caps the band; the count says 9
    expect(overview.info.every((a) => a.severity === 'info')).toBe(true)
  })

  it('enumerates every permalink for the sitemap with its own tier and date', async () => {
    const links = await alertPermalinks(db)
    expect(links).toHaveLength(12)
    expect(links.filter((l) => l.tier === 'alert')).toHaveLength(3)
    expect(links.filter((l) => l.tier === 'info')).toHaveLength(9)
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
