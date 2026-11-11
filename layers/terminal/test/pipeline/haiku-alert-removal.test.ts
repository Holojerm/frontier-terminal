import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import migration from '~~/server/db/migrations/0051_remove_haiku_prompt_length_alerts.sql?raw'
import { AlertRow } from '../../server/pipeline/contracts'
import { insertRows } from '../../server/pipeline/store'

// Migration 0051 deletes the two 2026-10-07 launch alerts for "models" that
// were Anthropic's prompt-length price bands for claude-haiku-5-5, read as
// names by the parser. The alerts below are as production stores them
// (/api/alerts); the two kept beside them are the real launch and the judge's
// alert on the prompt-length pricing.

const db = drizzle(env.DB, { schema })

const PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
const AT = '2026-10-07T18:00:17.796Z'

const alert = (row: Omit<AlertRow, 'change_ids'> & { change_ids: string[] }) =>
  AlertRow.parse({ ...row, change_ids: JSON.stringify(row.change_ids) })

const floor = (band: string, price: string, ids: string[]) =>
  alert({
    id:
      band === 'over'
        ? '3f4cefa36c7b4d957f541e6039ca2cda1300fd1c0d0efbc5d686a3c1a86e053c'
        : 'f65c31029a020f166cdecc02bfbbe63431f2039a2a34fffe31c02562ecb75062',
    severity: 'notable',
    headline: `Anthropic lists a new model, claude-haiku-5-5-(for-prompts-${band}-100,000-tokens) — ${price}`,
    explanation: `claude-haiku-5-5-(for-prompts-${band}-100,000-tokens) appears for the first time in Anthropic's catalog (${PRICING}), listed as standard, batch. A model no catalog has listed before always alerts — the model-floor rule, no model in the loop.`,
    rule: 'model-floor',
    created_at: AT,
    change_ids: ids,
    source_url: PRICING,
    fetched_at: AT,
  })

const OVER = floor('over', '$0.50 in / $2.50 out per MTok', [
  '8c513bc4364fcd7ec599a80e001126de03cf25dbd7a2cb6042023b47f90ab958',
  'd8d63784d5a1de42f135600b896ef279a0ae5a6362bc8602f743e8e285634a70',
])
const UP_TO = floor('up-to', '$0.10 in / $0.50 out per MTok', [
  '7276a781bcc62ee10712ddf2ef4097a3c45d3c627c3aa809ac96d525dbebfb4f',
  '2a82bb85287a423919987d26f33f7a0a16349a786cd88cb45503a041172c27fd',
])
const LAUNCH = alert({
  id: 'a404462dd2bb285ec4c0dd084c7e107f31c81117fbe677157987b2146dd10430',
  severity: 'notable',
  headline: 'Anthropic lists a new model, claude-haiku-5-5 — $0.10 in / $0.50 out per MTok',
  explanation:
    "claude-haiku-5-5 appears for the first time in Anthropic's catalog (https://platform.claude.com/docs/en/models/overview.md), listed as standard. A model no catalog has listed before always alerts — the model-floor rule, no model in the loop.",
  rule: 'model-floor',
  created_at: '2026-10-09T00:00:16.000Z',
  change_ids: ['f64b8f3b993b0dc790f11542178080006f800ae6447efd26d78f04f7349e723f'],
  source_url: 'https://platform.claude.com/docs/en/models/overview.md',
  fetched_at: '2026-10-09T00:00:16.000Z',
})
const PRICING_ALERT = alert({
  id: '0a3f7e16d3468804bfc9c4ab69cc516ade3835e1ca309a64b8e8355af0bea77a',
  severity: 'notable',
  headline:
    'Anthropic prices claude-haiku-5-5 by prompt length: input 0.1 vs 0.5 per MTok around the 100,000-token line',
  explanation: 'The pricing page adds four claude-haiku-5-5 rows.',
  rule: 'agent-judge',
  created_at: AT,
  change_ids: [...OVER.change_ids, ...UP_TO.change_ids].map(String),
  source_url: PRICING,
  fetched_at: AT,
})

/** One search, candidate and verdict scoring an alert, as the track record stores them. */
function trackRecord(alertId: string, n: number) {
  const prov = { source_url: 'https://example.com/story', fetched_at: AT }
  return {
    search: {
      id: `search-${n}`,
      alert_id: alertId,
      source: 'gdelt',
      query: 'claude haiku',
      window_start: AT,
      window_end: AT,
      status: 'ok',
      detail: null,
      candidates: 1,
      searched_at: AT,
      raw_key: null,
      source_url: prov.source_url,
    },
    candidate: {
      id: `candidate-${n}`,
      alert_id: alertId,
      kind: 'press',
      title: 'A story',
      snippet: null,
      outlet: 'example.com',
      url: prov.source_url,
      published_at: AT,
      search_id: `search-${n}`,
      found_at: AT,
      ...prov,
    },
    verdict: {
      id: `verdict-${n}`,
      candidate_id: `candidate-${n}`,
      alert_id: alertId,
      same_event: true,
      rationale: 'Same event.',
      judged_at: AT,
      ...prov,
    },
  }
}

async function store() {
  await insertRows(db, 'alerts', [OVER, UP_TO, LAUNCH, PRICING_ALERT])
  const scored = [trackRecord(OVER.id, 1), trackRecord(LAUNCH.id, 2)]
  await db.insert(schema.trackRecordSearches).values(scored.map((s) => s.search))
  await db.insert(schema.trackRecordCandidates).values(scored.map((s) => s.candidate))
  await db.insert(schema.trackRecordVerdicts).values(scored.map((s) => s.verdict))
}

/** Every statement in the file, as wrangler applies them: one per breakpoint. */
async function runMigration() {
  const statements = migration
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)))
}

const ids = async () => ({
  alerts: (await db.select().from(schema.alerts)).map((a) => a.id).sort(),
  searches: (await db.select().from(schema.trackRecordSearches)).map((r) => r.alert_id),
  candidates: (await db.select().from(schema.trackRecordCandidates)).map((r) => r.alert_id),
  verdicts: (await db.select().from(schema.trackRecordVerdicts)).map((r) => r.alert_id),
})

describe('migration 0051: the two prompt-length "launches"', () => {
  beforeEach(async () => {
    for (const table of [
      schema.trackRecordVerdicts,
      schema.trackRecordCandidates,
      schema.trackRecordSearches,
      schema.alerts,
    ])
      await db.delete(table)
  })

  it('deletes the two alerts and their track record, and keeps the real launch and the pricing alert', async () => {
    await store()
    await runMigration()
    expect(await ids()).toEqual({
      alerts: [PRICING_ALERT.id, LAUNCH.id].sort(),
      searches: [LAUNCH.id],
      candidates: [LAUNCH.id],
      verdicts: [LAUNCH.id],
    })
  })

  it('touches nothing when the alerts are absent, and a second run removes nothing more', async () => {
    await runMigration()
    expect((await ids()).alerts).toEqual([])
    await store()
    await runMigration()
    const once = await ids()
    await runMigration()
    expect(await ids()).toEqual(once)
  })
})
