import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { evaluateTheses } from '../server/theses/evaluate'
import { queryContext } from '../server/utils/terminal-db'
import { daysBefore } from '../server/utils/terminal-rankings'
import { queryTheses } from '../server/utils/terminal-theses'
import { fixtureText } from './pipeline/fixtures'

// The evaluator against a real D1, seeded with the rows the pipeline would
// have stored: 40 days of rankings, two priced SKUs, and an Anthropic job
// board. Checks what lands in claim_readings and claim_status_changes, that
// a second run with nothing new writes no status rows, and that the API
// payload reads back the same statuses.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const NEWEST = '2026-10-07'
const NOW = new Date('2026-10-08T12:00:00Z')
const RANKINGS_URL = 'https://openrouter.ai/api/v1/datasets/rankings-daily'
const BOARD_URL = 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs'

const entity = (
  source_id: string,
  entity_key: string,
  entity_type: string,
  provider: string,
  payload: Record<string, unknown>,
  source_url: string,
) => ({
  source_id,
  entity_key,
  entity_type,
  provider,
  content_hash: entity_key,
  payload: JSON.stringify(payload),
  snapshot_id: `snap-${source_id}`,
  first_seen_at: '2026-08-25T00:00:00Z',
  source_url,
  fetched_at: '2026-10-08T06:00:00Z',
})

// Tokens per day: Anthropic 25% of the four labs; OpenAI 50%.
const DAILY_TOKENS = {
  'anthropic/claude-sonnet-5-5': 250,
  'openai/gpt-6-sol': 500,
  'google/gemini-3-pro': 200,
  'x-ai/grok-5': 50,
} as const

beforeAll(async () => {
  const rankings = []
  for (let d = 39; d >= 0; d--) {
    const date = daysBefore(NEWEST, d)
    for (const [slug, tokens] of Object.entries(DAILY_TOKENS)) {
      const provider = {
        anthropic: 'anthropic',
        openai: 'openai',
        google: 'google',
        'x-ai': 'xai',
      }[slug.split('/')[0]!]!
      rankings.push(
        entity(
          'openrouter-rankings-daily',
          `ranking:${date}:${slug}`,
          'ranking',
          provider,
          { date, model_permaslug: slug, total_tokens: tokens * 1_000_000 },
          RANKINGS_URL,
        ),
      )
    }
  }
  const catalog = [
    entity(
      'anthropic-pricing-md',
      'model:anthropic:claude-sonnet-5-5',
      'model',
      'anthropic',
      {
        model_slug: 'claude-sonnet-5-5',
        tier: null,
        input_per_mtok: 2,
        output_per_mtok: 10,
      },
      'https://platform.claude.com/docs/en/about-claude/pricing.md',
    ),
    entity(
      'openai-pricing-md',
      'model:openai:gpt-6-sol',
      'model',
      'openai',
      {
        model_slug: 'gpt-6-sol',
        tier: 'standard',
        input_per_mtok: 0.5,
        output_per_mtok: 2.5,
      },
      'https://developers.openai.com/api/docs/pricing.md',
    ),
  ]
  const jobs = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, department: 'Sales' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, department: 'Compute' })),
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `r${i}`,
      department: 'AI Research & Engineering',
    })),
  ].map((j) =>
    entity(
      'anthropic-greenhouse',
      `job:anthropic:${j.id}`,
      'job',
      'anthropic',
      {
        job_id: j.id,
        title: 'Role',
        department: j.department,
      },
      BOARD_URL,
    ),
  )
  for (const row of [...rankings, ...catalog, ...jobs]) await db.insert(schema.entities).values(row)
  await db.insert(schema.snapshots).values({
    id: 'snap-anthropic-greenhouse',
    source_id: 'anthropic-greenhouse',
    content_hash: 'h',
    raw_key: 'raw/h',
    http_status: 200,
    bytes: 1,
    source_url: BOARD_URL,
    fetched_at: '2026-08-25T11:10:43Z',
  })
})

const deps = { sourcesYaml, now: () => NOW }

describe('evaluateTheses', () => {
  it('stores readings for the measured claims and a first status row for every claim', async () => {
    const runs = await evaluateTheses(db, deps)
    const by = Object.fromEntries(runs.map((r) => [r.claim_id, r]))

    // Spend premium: only the newest window, today's prices.
    expect(by['anthropic-spend-premium']!.readings_written).toBe(1)
    // Lab token share: every day with a full 7-day window behind it.
    expect(by['anthropic-demand-growth']!.readings_written).toBe(34)
    // Open roles: one per day since the board's first snapshot.
    expect(by['anthropic-hiring-scale']!.readings_written).toBeGreaterThan(40)

    expect(by['anthropic-spend-premium']!.status).toBe('holding')
    expect(by['anthropic-demand-growth']!.status).toBe('holding')
    expect(by['anthropic-hiring-scale']!.status).toBe('holding')
    expect(by['anthropic-rival-price-war']!.status).toBe('unresolved')
    expect(by['anthropic-safety-asset']!.status).toBe('unresolved')
    expect(runs.every((r) => r.changed)).toBe(true)

    const readings = await db.select().from(schema.claimReadings)
    const share = readings.find(
      (r) => r.claim_id === 'anthropic-demand-growth' && r.date === NEWEST,
    )!
    expect(share.value).toBe(0.25)
    expect(share.source_url).toBe(RANKINGS_URL)
    const roles = readings.filter((r) => r.claim_id === 'anthropic-hiring-scale').at(-1)!
    expect(roles.value).toBe(17)
    expect(JSON.parse(roles.detail).by_department).toEqual({ Sales: 12, Compute: 5 })
  })

  it('writes no status row and rewrites no reading when nothing moved', async () => {
    const before = await db.select().from(schema.claimReadings)
    const runs = await evaluateTheses(db, {
      sourcesYaml,
      now: () => new Date('2026-10-08T18:00:00Z'),
    })
    expect(runs.some((r) => r.changed)).toBe(false)
    const log = await db.select().from(schema.claimStatusChanges)
    expect(log.filter((r) => r.thesis_id === 'anthropic')).toHaveLength(5)
    const after = await db.select().from(schema.claimReadings)
    expect(after.map((r) => r.computed_at)).toEqual(before.map((r) => r.computed_at))
  })

  it('serves the same statuses through the API payload, with status_since from the log', async () => {
    const data = await queryTheses(
      db,
      queryContext(sourcesYaml, '2026-10-08T06:00:00Z', () => NOW),
    )
    const thesis = data.theses[0]!
    expect(thesis.id).toBe('anthropic')
    expect(thesis.claims.map((c) => c.status)).toEqual([
      'holding',
      'holding',
      'unresolved',
      'holding',
      'unresolved',
    ])
    const premium = thesis.claims[0]!
    expect(premium.status_since).toBe(NOW.toISOString())
    expect(premium.latest?.date).toBe(NEWEST)
    expect(premium.reason).toMatch(/against a floor of 1\.30× and OpenAI's/)
  })
})
