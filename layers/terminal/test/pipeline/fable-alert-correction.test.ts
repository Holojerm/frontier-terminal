import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import migration from '~~/server/db/migrations/0045_correct_fable_alert.sql?raw'
import { AlertRow, ChangeRow } from '../../server/pipeline/contracts'
import { corpusOf, groundingFailure } from '../../server/pipeline/judge/grounding'
import { falseDelisting } from '../../server/pipeline/judge/still-listed'
import { insertRows } from '../../server/pipeline/store'

// Migration 0045 rewrites the 2026-11-09 judge alert that called
// claude-fable-5-1 delisted. The records below are the six change rows it
// cites, copied from production's /export/changes.json, so the corrected text
// is held to the same two gates a new alert meets: grounding and still-listed.

const db = drizzle(env.DB, { schema })

const ALERT_ID = '645cb39b89c3a4c721ea09cb5a147bf31c3d80816d7efe60511c2644f5c3d3d8'
const OVERVIEW = 'https://platform.claude.com/docs/en/models/overview.md'
const PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
const AT_OVERVIEW = '2026-11-09T19:00:58.859Z'
const AT_PRICING = '2026-11-09T19:00:59.817Z'

const row = (
  model_slug: string,
  tier: string | null,
  input: number,
  output: number,
  extra: { cached?: number; context?: string; notes?: string } = {},
) =>
  JSON.stringify({
    cached_input_per_mtok: extra.cached ?? null,
    context_window: extra.context ?? null,
    currency: 'USD',
    effective_from: null,
    effective_until: null,
    input_per_mtok: input,
    model_slug,
    notes: extra.notes ?? null,
    output_per_mtok: output,
    provider: 'anthropic',
    tier,
  })

function cited(
  id: string,
  entity_key: string,
  change_type: 'added' | 'removed',
  hash: string,
  json: string,
  source_url: string,
  at: string,
): ChangeRow {
  return ChangeRow.parse({
    id,
    entity_key,
    entity_type: 'model',
    provider: 'anthropic',
    change_type,
    before_hash: change_type === 'removed' ? hash : null,
    after_hash: change_type === 'added' ? hash : null,
    before_json: change_type === 'removed' ? json : null,
    after_json: change_type === 'added' ? json : null,
    detected_at: at,
    source_url,
    fetched_at: at,
  })
}

const LONG_HORIZON = 'For demanding reasoning and long-horizon agentic work'
const CACHE_WRITES = '5m cache writes $10 / MTok; 1h cache writes $16 / MTok'

const CHANGES = [
  cited(
    '1e31eabb0447a324f09995b9f15ac2eb3729354f08a19fe10184994c9fec190f',
    'model:anthropic:claude-fable-5-1',
    'removed',
    '1c120e8b0e3dbf8b168af0a85e0709a98f4c10969b123bb2653699e583a35f90',
    row('claude-fable-5-1', null, 10, 50, { context: '1M tokens', notes: LONG_HORIZON }),
    OVERVIEW,
    AT_OVERVIEW,
  ),
  cited(
    'ec8404583c40d7cb31e2a3acc95130d751f150a2b0e4aa2d4f02a627237eca44',
    'model:anthropic:claude-fable-5-2',
    'added',
    '52f5dea2222b7e217258a3c98d4277d45be9d75d5c5d496204643b5d5f060daf',
    row('claude-fable-5-2', null, 8, 40, { context: '1M tokens', notes: LONG_HORIZON }),
    OVERVIEW,
    AT_OVERVIEW,
  ),
  cited(
    '0cad2133741269a89f8dfdc698a8a75d1de9cbc5106400592a052cc1270c7977',
    'model:anthropic:claude-fable-5-2:batch',
    'added',
    '1140bd188293f9e021e63af90014a18025ccb0f133c5a6a4a260e052b26a021b',
    row('claude-fable-5-2', 'batch', 4, 20),
    PRICING,
    AT_PRICING,
  ),
  cited(
    '32807cec5b8dcc64952554040e32d4a14011cba4e69139f956e2c1296b195e65',
    'model:anthropic:claude-fable-5-2',
    'added',
    'e4d9333d0b74cd959bd868ef4b6f30d5e633b81d5d8e8f16ea28fa73d87db1e5',
    row('claude-fable-5-2', null, 8, 40, { cached: 0.2, notes: CACHE_WRITES }),
    PRICING,
    AT_PRICING,
  ),
  cited(
    '4e5cefdfb390d8eafc9a7b5c9f5002c8f06002961197145587b656b1652aaede',
    'model:anthropic:claude-mythos-5-2',
    'added',
    '50f8d8cae05721ffa235f4668d39a6274f26576b45a119768a64d602955815a4',
    row('claude-mythos-5-2', null, 8, 40, {
      cached: 0.2,
      notes: `limited availability; ${CACHE_WRITES}`,
    }),
    PRICING,
    AT_PRICING,
  ),
  cited(
    'd78c16f6d103a5f8f01a9e2345693bffae44a0c105b4f07bc03095f172970667',
    'model:anthropic:claude-mythos-5-2:batch',
    'added',
    '56c4ec80f01c89b9899678f1950788aad2e73d271f4e9985d503488a5eac3e73',
    row('claude-mythos-5-2', 'batch', 4, 20, { notes: 'limited availability' }),
    PRICING,
    AT_PRICING,
  ),
]

const ORIGINAL = AlertRow.parse({
  id: ALERT_ID,
  severity: 'notable',
  headline: 'Anthropic delists claude-fable-5-1, launches claude-fable-5-2 and claude-mythos-5-2',
  explanation:
    "Anthropic's model catalog removed claude-fable-5-1, which priced input at 10 and output at 50 per MTok. It added claude-fable-5-2 (input 8, output 40 per MTok, plus a batch tier at input 4, output 20 per MTok) and claude-mythos-5-2, limited availability (input 8, output 40 per MTok, plus a batch tier at input 4, output 20 per MTok).",
  change_ids: JSON.stringify(CHANGES.map((c) => c.id).sort()),
  rule: 'agent-judge',
  created_at: AT_PRICING,
  source_url: PRICING,
  fetched_at: AT_PRICING,
})

const runMigration = () => env.DB.prepare(migration).run()

beforeEach(async () => {
  await db.delete(schema.alerts)
})

describe('migration 0045: the claude-fable-5-1 alert', () => {
  it('rewrites the alert in place, keeping its id, citations, severity and provenance', async () => {
    await insertRows(db, 'alerts', [ORIGINAL])
    await runMigration()
    const [stored] = await db.select().from(schema.alerts).where(eq(schema.alerts.id, ALERT_ID))
    expect(stored).toMatchObject({
      id: ALERT_ID,
      severity: 'notable',
      rule: 'agent-judge',
      change_ids: ORIGINAL.change_ids,
      created_at: ORIGINAL.created_at,
      source_url: ORIGINAL.source_url,
      fetched_at: ORIGINAL.fetched_at,
    })
    expect(stored!.headline).not.toBe(ORIGINAL.headline)
    expect(stored!.headline).toContain('drops claude-fable-5-1')
  })

  it('holds the new text to the gates a new alert meets; the old text fails them', async () => {
    await insertRows(db, 'alerts', [ORIGINAL])
    await runMigration()
    const [stored] = await db.select().from(schema.alerts)
    const corpus = corpusOf(CHANGES)
    const fixed = `${stored!.headline}\n${stored!.explanation}`
    expect(groundingFailure(fixed, corpus)).toBeNull()
    expect(falseDelisting(fixed, ['claude-fable-5-1'], corpus)).toBeNull()
    const original = `${ORIGINAL.headline}\n${ORIGINAL.explanation}`
    expect(groundingFailure(original, corpus)).toBeNull()
    expect(falseDelisting(original, ['claude-fable-5-1'], corpus)).not.toBeNull()
  })

  it('touches nothing when the alert is absent or already corrected', async () => {
    await runMigration()
    expect(await db.select().from(schema.alerts)).toEqual([])
    await insertRows(db, 'alerts', [ORIGINAL])
    await runMigration()
    const [once] = await db.select().from(schema.alerts)
    await runMigration()
    const [twice] = await db.select().from(schema.alerts)
    expect(twice).toEqual(once)
  })
})
