import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vitest'

import type { ThesisDef } from '#shared/utils/thesis-types'

import * as schema from '../server/db/schema'
import type { FetchOutcome, SourceFetcher } from '../server/pipeline/fetch'
import { evaluateTheses } from '../server/theses/evaluate'
import { evaluateJudgedClaim } from '../server/theses/judged-status'
import { trailingSum, yoyGrowth, type Point } from '../server/theses/recipe-signals'
import type { Recipe } from '../server/theses/recipes/contract'
import { runRecipes } from '../server/theses/recipes/run'
import { applyClaimVerdicts, claimReview } from '../server/theses/verdicts'
import { fixtureText } from './pipeline/fixtures'

// The recipe engine on a made-up company: a quarterly revenue recipe, a
// daily download recipe and a changelog recipe, fetched through a fake
// fetcher; the runner's storage and failure rules; the recipe signals; and
// a recipe-items claim rated through the verdict gate.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const NOW = new Date('2026-10-09T12:00:00Z')

const json = (v: unknown): FetchOutcome => {
  const text = JSON.stringify(v)
  return { ok: true, status: 200, text, bytes: text.length }
}

const quarters = (values: Record<string, number>) =>
  Object.entries(values).map(([date, value]) => ({ key: 'revenue', date, value, payload: {} }))

const REVENUE: Recipe = {
  id: 'test-revenue',
  company: 'cloudflare',
  description: 'test revenue',
  url: () => 'https://example.test/revenue.json',
  ext: 'json',
  extract: (body) => quarters(JSON.parse(body) as Record<string, number>),
}
const RIVAL: Recipe = {
  ...REVENUE,
  id: 'test-rival',
  company: 'fastly',
  url: () => 'https://example.test/rival.json',
}
const CHANGELOG: Recipe = {
  id: 'test-changelog',
  company: 'cloudflare',
  description: 'test changelog',
  url: () => 'https://example.test/changelog.json',
  ext: 'json',
  extract: (body) =>
    (JSON.parse(body) as { id: string; title: string; date: string }[]).map((e) => ({
      key: e.id,
      date: e.date,
      value: null,
      payload: { title: e.title },
    })),
}

const BODIES: Record<string, unknown> = {
  'https://example.test/revenue.json': {
    '2025-03-31': 400,
    '2025-06-30': 450,
    '2026-03-31': 520,
    '2026-06-30': 540,
  },
  'https://example.test/rival.json': { '2025-06-30': 100, '2026-06-30': 110 },
  'https://example.test/changelog.json': [
    { id: 'agents-sdk-2', title: 'Agents SDK 2.0', date: '2026-10-01' },
    { id: 'typo-fix', title: 'Fixed a docs typo', date: '2026-10-02' },
  ],
}
let failNext = false
const fetcher: SourceFetcher = async (source) => {
  if (failNext) return { ok: false, status: 500, detail: 'HTTP 500' }
  return json(BODIES[source.url])
}
const raw = { put: async (key: string, body: string) => void (await env.BLOB.put(key, body)) }

const THESIS: ThesisDef = {
  id: 'test-cloud',
  company: 'cloudflare',
  stance: 'bullish',
  statement: 'test',
  comparison_set: ['fastly'],
  horizon: 'test',
  position: 'none',
  opened: '2026-10-09',
  doc_path: 'docs/theses/test.md',
  claims: [
    {
      id: 'test-growth',
      n: 1,
      text: 'Revenue grows 25% or more',
      signal_label: 'YoY revenue growth',
      kill_condition: 'Below 25% for 2 straight quarters',
      spec: {
        kind: 'measured',
        signal: 'recipe-yoy-growth',
        recipe: 'test-revenue',
        key: 'revenue',
        compare_recipes: ['test-rival'],
        format: 'percent',
        rule: { rule: 'below-floor-periods', floor: 0.25, periods: 2 },
      },
    },
    {
      id: 'test-launches',
      n: 2,
      text: 'Ships launches',
      signal_label: 'Changelog entries rated',
      kill_condition: 'No major launch in 90 days',
      spec: {
        kind: 'judged',
        review: 'recipe-items',
        recipe: 'test-changelog',
        verdicts: ['major', 'minor'],
        judged_from: '2026-10-09',
        rubric: 'major: a new product or a GA launch. minor: everything else.',
        rule: { rule: 'recent-verdict', verdict: 'major', days: 90 },
      },
    },
  ],
}

describe('recipe arithmetic', () => {
  const p = (date: string, value: number): Point => ({
    date,
    value,
    source_url: 'u',
    fetched_at: 'f',
  })

  it('grows each period against the one a year earlier, skipping periods with no base', () => {
    const g = yoyGrowth([p('2025-06-30', 400), p('2026-06-30', 540), p('2026-03-31', 500)])
    expect(g.map((x) => [x.date, x.value])).toEqual([['2026-06-30', 0.35]])
  })

  it('sums only trailing windows that are whole', () => {
    const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05']
    expect(
      trailingSum(
        days.map((d, i) => p(d, i + 1)),
        3,
      ).map((x) => [x.date, x.value]),
    ).toEqual([['2026-10-03', 6]])
  })
})

describe('runRecipes', () => {
  const recipes = [REVENUE, RIVAL, CHANGELOG]

  it('stores observations and a run row per recipe', async () => {
    const results = await runRecipes(db, { raw, fetcher, now: () => NOW }, recipes)
    expect(results.map((r) => [r.recipe_id, r.status, r.observations])).toEqual([
      ['test-revenue', 'ok', 4],
      ['test-rival', 'ok', 2],
      ['test-changelog', 'ok', 2],
    ])
    const rows = await db.select().from(schema.recipeObservations)
    expect(rows).toHaveLength(8)
    expect(
      rows.every(
        (r) => r.source_url.startsWith('https://example.test/') && r.raw_key.startsWith('recipes/'),
      ),
    ).toBe(true)
  })

  it('marks identical bytes unchanged, and flags a failure without touching stored rows', async () => {
    const again = await runRecipes(db, { raw, fetcher, now: () => NOW }, [REVENUE])
    expect(again[0]!.status).toBe('unchanged')
    failNext = true
    const failed = await runRecipes(db, { raw, fetcher, now: () => NOW }, [REVENUE])
    failNext = false
    expect(failed[0]).toMatchObject({ status: 'failed', detail: 'HTTP 500' })
    expect(await db.select().from(schema.recipeObservations)).toHaveLength(8)
    const ops = await db.select().from(schema.opsEvents)
    expect(ops.map((o) => o.kind)).toContain('recipe_failed')
  })
})

describe('recipe signals and recipe-item claims', () => {
  it('reads growth from observations, with the comparison set beside it', async () => {
    const runs = await evaluateTheses(db, { sourcesYaml, now: () => NOW }, [THESIS])
    expect(runs.find((r) => r.claim_id === 'test-growth')).toMatchObject({ status: 'weakening' })
    const readings = await db.select().from(schema.claimReadings)
    expect(readings.map((r) => r.date).sort()).toEqual(['2026-03-31', '2026-06-30'])
    const reading = readings.find((r) => r.date === '2026-06-30')
    expect(reading!.value).toBe(0.2)
    expect(JSON.parse(reading!.detail).rivals).toEqual({ 'test-rival': 0.1 })
  })

  it('offers unrated recipe items, gates their verdicts, and stops offering rated ones', async () => {
    const review = await claimReview(db, [], new Map(), [THESIS])
    expect(review.map((r) => [r.claim_id, r.candidates.length])).toEqual([['test-launches', 2]])
    const ids = Object.fromEntries(
      review[0]!.candidates.map((c) => [String(c.facts.title), c.change_id]),
    )
    const report = await applyClaimVerdicts(
      db,
      [
        {
          claim_id: 'test-launches',
          change_id: ids['Agents SDK 2.0']!,
          verdict: 'major',
          rationale: '"Agents SDK 2.0" is a new major version.',
        },
        {
          claim_id: 'test-launches',
          change_id: ids['Fixed a docs typo']!,
          verdict: 'huge',
          rationale: 'A typo.',
        },
      ],
      NOW,
      [THESIS],
    )
    expect(report.inserted).toBe(1)
    expect(report.rejected.map((r) => r.reason)).toEqual(['unknown-verdict'])
    const left = await claimReview(db, [], new Map(), [THESIS])
    expect(left[0]!.candidates.map((c) => c.facts.title)).toEqual(['Fixed a docs typo'])
  })

  it('holds with a recent major item, weakens past half the window, breaks past all of it', () => {
    const claim = THESIS.claims[1]!
    const v = (detected_at: string, verdict: string) => ({
      subject: detected_at,
      provider: 'cloudflare' as const,
      verdict,
      facts: { title: 'x' },
      detected_at,
    })
    const at = (vs: ReturnType<typeof v>[], now: string) =>
      evaluateJudgedClaim(claim, 'cloudflare', vs, null, now).status
    expect(at([], '2026-10-09T00:00:00Z')).toBe('unresolved')
    expect(at([v('2026-10-01', 'major')], '2026-10-09T00:00:00Z')).toBe('holding')
    expect(at([v('2026-10-01', 'major')], '2026-12-01T00:00:00Z')).toBe('weakening')
    expect(at([v('2026-10-01', 'minor')], '2026-10-20T00:00:00Z')).toBe('unresolved')
    expect(at([v('2026-10-01', 'minor')], '2027-01-15T00:00:00Z')).toBe('broken')
  })
})
