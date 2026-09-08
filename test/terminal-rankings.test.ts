import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { OPENROUTER_KEY_UNSET, type SourceFetcher } from '../server/pipeline/fetch'
import { runRefresh, type RawStore, type RefreshDeps } from '../server/pipeline/refresh'
import { terminalStamp } from '../server/utils/terminal-cache'
import { queryContext, queryCoverage } from '../server/utils/terminal-db'
import { EXPORT_TABLES } from '../server/utils/terminal-export'
import {
  SERIES_DAYS,
  daysBefore,
  queryRankings,
  summarizeRankings,
  type RankingObservation,
} from '../server/utils/terminal-rankings'
import { fixtureText } from './pipeline/fixtures'

// The share arithmetic without a database, then the query against the real
// D1 in each of the three states the panel has to render honestly.

const PROV = {
  source_url: 'https://openrouter.ai/api/v1/datasets/rankings-daily',
  fetched_at: '2026-09-07T10:00:00Z',
}
const day = (offset: number) => daysBefore('2026-09-30', offset)

/** N days of synthetic observations, newest = 2026-09-30. Tokens per provider
 * per day are fixed so every expected share below is arithmetic on them. */
function synthetic(days: number): RankingObservation[] {
  const rows: RankingObservation[] = []
  for (let i = 0; i < days; i++) {
    const date = day(i)
    const older = i >= 7 // the prior window and beyond carry a different mix
    rows.push(
      {
        date,
        provider: 'openai',
        model_permaslug: 'openai/a',
        total_tokens: older ? 300 : 200,
        ...PROV,
      },
      { date, provider: 'openai', model_permaslug: 'openai/b', total_tokens: 100, ...PROV },
      {
        date,
        provider: 'anthropic',
        model_permaslug: 'anthropic/a',
        total_tokens: older ? 200 : 300,
        ...PROV,
      },
      { date, provider: 'google', model_permaslug: 'google/a', total_tokens: 100, ...PROV },
      { date, provider: 'xai', model_permaslug: 'x-ai/a', total_tokens: 50, ...PROV },
      { date, provider: 'other', model_permaslug: 'deepseek/a', total_tokens: 150, ...PROV },
      { date, provider: 'other', model_permaslug: 'other', total_tokens: 100, ...PROV },
    )
  }
  return rows
}

describe('summarizeRankings', () => {
  it('is empty, not a throw, on no rows', () => {
    const s = summarizeRankings([])
    expect(s.coverage).toEqual({
      days: 0,
      first_date: null,
      last_date: null,
      window: null,
      prior_window: null,
    })
    expect(s.shares.map((p) => [p.provider, p.share, p.delta_pp])).toEqual([
      ['openai', null, null],
      ['anthropic', null, null],
      ['google', null, null],
      ['xai', null, null],
      ['other', null, null],
    ])
    expect(s.top_models.map((t) => t.models)).toEqual([[], [], [], []])
    expect(s.series).toEqual([])
  })

  it('shares are of the newest seven days present and sum to one; the delta is against the seven before', () => {
    const s = summarizeRankings(synthetic(20))
    expect(s.coverage).toMatchObject({
      days: 20,
      window: { from: day(6), to: day(0) },
      prior_window: { from: day(13), to: day(7) },
    })
    // Window day total 1000; prior day total 1000 with openai/anthropic swapped.
    const byId = Object.fromEntries(s.shares.map((p) => [p.provider, p]))
    expect(byId.openai).toMatchObject({
      tokens: 7 * 300,
      share: 0.3,
      prior_tokens: 7 * 400,
      prior_share: 0.4,
    })
    expect(byId.openai!.delta_pp).toBeCloseTo(-10, 9)
    expect(byId.anthropic!.delta_pp).toBeCloseTo(10, 9)
    expect(byId.google).toMatchObject({ share: 0.1, delta_pp: 0 })
    expect(byId.other).toMatchObject({ share: 0.25, delta_pp: 0 })
    expect(s.shares.reduce((acc, p) => acc + (p.share ?? 0), 0)).toBeCloseTo(1, 9)
  })

  it('with fewer than eight days there is no prior window and no delta, not a change from zero', () => {
    const s = summarizeRankings(synthetic(5))
    expect(s.coverage.prior_window).toBeNull()
    for (const p of s.shares) {
      expect(p.prior_share).toBeNull()
      expect(p.delta_pp).toBeNull()
    }
    expect(s.shares.find((p) => p.provider === 'openai')!.share).toBe(0.3)
  })

  it('top models are per lab within the window, by tokens, never the aggregate row', () => {
    const s = summarizeRankings(synthetic(20))
    const openai = s.top_models.find((t) => t.provider === 'openai')!
    expect(openai.models.map((m) => [m.model_permaslug, m.tokens, m.share_of_provider])).toEqual([
      ['openai/a', 1400, 1400 / 2100],
      ['openai/b', 700, 700 / 2100],
    ])
    expect(openai.models[0]).toMatchObject(PROV)
    expect(s.top_models.map((t) => t.provider)).toEqual(['openai', 'anthropic', 'google', 'xai'])
    expect(s.top_models.flatMap((t) => t.models.map((m) => m.model_permaslug))).not.toContain(
      'other',
    )
  })

  it('the series is the newest SERIES_DAYS days, ascending, with the day total', () => {
    const s = summarizeRankings(synthetic(45))
    expect(s.series).toHaveLength(SERIES_DAYS)
    expect(s.series[0]!.date).toBe(day(SERIES_DAYS - 1))
    expect(s.series.at(-1)).toEqual({
      date: day(0),
      tokens: { openai: 300, anthropic: 300, google: 100, xai: 50, other: 250 },
      total: 1000,
    })
  })

  it('daysBefore is calendar arithmetic in UTC', () => {
    expect(daysBefore('2026-03-01', 1)).toBe('2026-02-28')
    expect(daysBefore('2026-01-01', 1)).toBe('2025-12-31')
    expect(daysBefore('2026-09-30', 0)).toBe('2026-09-30')
  })
})

// ── against D1 ──────────────────────────────────────────────────────────────

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const SOURCE_ID = 'openrouter-rankings-daily'
const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}
let tick = Date.parse('2026-09-07T10:00:00Z')
const now = () => new Date((tick += 1000))
const deps = (fetcher: SourceFetcher): RefreshDeps => ({ db, raw, fetcher, sourcesYaml, now })
const FIXED_NOW = () => new Date('2026-09-07T12:00:00Z')
const ctx = async () => queryContext(sourcesYaml, await terminalStamp(db), FIXED_NOW)

const fixtureFetcher: SourceFetcher = async () => {
  const text = fixtureText('fixtures/rankings/openrouter-rankings-daily.json')
  return { ok: true, status: 200, text, bytes: text.length }
}
const skippedFetcher: SourceFetcher = async () => ({
  ok: false,
  status: null,
  detail: OPENROUTER_KEY_UNSET,
  skipped: true,
})

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

describe('queryRankings', () => {
  it('empty store: no_rows, with the source, its license and the citation template still served', async () => {
    const r = await queryRankings(db, await ctx())
    expect(r.status).toBe('no_rows')
    expect(r.as_of).toBeNull()
    expect(r.provenance).toBeNull()
    expect(r.source).toMatchObject({
      source_id: SOURCE_ID,
      label: 'OpenRouter usage rankings (daily)',
      url: 'https://openrouter.ai/api/v1/datasets/rankings-daily',
      last_run: null,
      newest_snapshot: null,
    })
    expect(r.source.license).toContain('CC BY 4.0')
    expect(r.source.caveat).toContain('OpenRouter share, not market share')
    expect(r.meta.as_of).toBeNull()
    expect(r.meta.citation).toBe(
      'Source: OpenRouter (openrouter.ai/rankings), as of (as_of not yet recorded). Licensed under CC BY 4.0.',
    )
    expect(r.shares.every((p) => p.share === null)).toBe(true)
  })

  it('after a skipped run: not_configured, and the coverage panel says so', async () => {
    await runRefresh(deps(skippedFetcher), 'survey', [SOURCE_ID])
    const r = await queryRankings(db, await ctx())
    expect(r.status).toBe('not_configured')
    expect(r.source.last_run).toMatchObject({ status: 'skipped', detail: OPENROUTER_KEY_UNSET })
    expect(r.provenance).toBeNull()

    const coverage = await queryCoverage(db, await ctx())
    const row = coverage.sources.find((s) => s.source_id === SOURCE_ID)!
    expect(row.last_run!.status).toBe('skipped')
    expect(row.axis).toBe('demand-share')
    expect(coverage.cuts.map((c) => c.id)).toEqual([
      'google-hiring',
      'artificial-analysis',
      'lmarena',
      'compute-deals',
      'xai-status',
    ])
    expect(coverage.cuts.find((c) => c.id === 'artificial-analysis')!.reason).toContain(
      '"Internal use only; no redistribution."',
    )
  })

  it('after a baseline of the fixture: ok, the exact citation with OpenRouter’s as_of, and provenance from the fetch', async () => {
    await runRefresh(deps(fixtureFetcher), 'survey', [SOURCE_ID])
    const r = await queryRankings(db, await ctx())
    expect(r.status).toBe('ok')
    expect(r.meta.as_of).toBe('2026-09-07T02:00:00.000Z')
    expect(r.meta.citation).toBe(
      'Source: OpenRouter (openrouter.ai/rankings), as of 2026-09-07T02:00:00.000Z. Licensed under CC BY 4.0.',
    )
    expect(r.provenance!.source_url).toBe('https://openrouter.ai/api/v1/datasets/rankings-daily')
    expect(r.provenance!.fetched_at).toMatch(/^2026-09-07T10:00:\d\d\.000Z$/)
    expect(r.meta.coverage).toEqual({
      days: 3,
      first_date: '2026-09-04',
      last_date: '2026-09-06',
      window: { from: '2026-09-04', to: '2026-09-06' },
      prior_window: null,
    })
    // Fixture arithmetic: anthropic 3 days × (sonnet + opus).
    const anthropic = r.shares.find((p) => p.provider === 'anthropic')!
    expect(anthropic.tokens).toBe(910e9 + 280e9 + 950e9 + 300e9 + 980e9 + 320e9)
    expect(r.shares.reduce((acc, p) => acc + (p.share ?? 0), 0)).toBeCloseTo(1, 9)
    expect(
      r.top_models.find((t) => t.provider === 'anthropic')!.models.map((m) => m.model_permaslug),
    ).toEqual(['anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.5'])
    expect(r.series.map((d) => d.date)).toEqual(['2026-09-04', '2026-09-05', '2026-09-06'])
    expect(r.series[0]!.tokens.other).toBe(2400e9 + 310e9)

    // The export view flattens the same rows.
    const view = EXPORT_TABLES.rankings_daily!
    expect(await view.count(db)).toBe(24)
    const [first] = await view.page(db, 0, 1)
    expect(Object.keys(first!)).toEqual(view.columns)
    expect(first).not.toHaveProperty('entity_type')
    expect(first!.model_permaslug).toEqual(expect.any(String))
  })
})
