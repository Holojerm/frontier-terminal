import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import migration from '~~/server/db/migrations/0053_correct_google_reworded_sentence_alert.sql?raw'
import { AlertRow, ChangeRow } from '#layers/core/server/pipeline/contracts'
import { requotedKey } from '../../../pricing/server/pipeline/judge/class-map'
import { corpusOf, groundingFailure } from '#layers/core/server/pipeline/judge/grounding'
import { clampRoutineAlerts } from '../../server/pipeline/judge/severity-gates'
import { insertRows } from '#layers/core/server/pipeline/store'

// On 2026-11-18 Google cut the last clause of gemini-4-hydrogen's card. The
// drift check reported the quoted sentence gone, and the judge's alert read
// that as Google dropping the model from its balanced class, while the same
// model stayed mapped on the shortened sentence. The alert and the change row
// it cites are copied here from production (/api/alerts and
// /export/changes.json).

const db = drizzle(env.DB, { schema })

const OLD_BASIS =
  'Brings cutting-edge intelligence to everyone, with speed and efficiency for everyday coding and agentic workflows, featuring a shared 1M context window and long decodes up to 1M tokens.'
const recommendation = (present: boolean) =>
  JSON.stringify({
    basis: OLD_BASIS,
    class: 'balanced',
    model_slug: 'gemini-4-hydrogen',
    present,
    provider: 'google',
  })

const CHANGE = ChangeRow.parse({
  id: 'c0af95831584089a69c6a0568a6547cea517866f6233eacd133801239d370500',
  entity_key: 'recommendation:google:balanced',
  entity_type: 'recommendation',
  provider: 'google',
  change_type: 'modified',
  before_hash: '5ef76c8bbfbf7217a2c089368923b1aa787af705af4f15922046e02e02db9eb1',
  after_hash: '08693d178be2c499fbccef6efad0ad1bc37097eb2a1f4584afe0c38221ba1826',
  before_json: recommendation(true),
  after_json: recommendation(false),
  detected_at: '2026-11-18T21:00:59.601Z',
  source_url: 'https://aistudio.google.com/docs/models.md',
  fetched_at: '2026-11-18T21:00:59.601Z',
})

const RECORDED = AlertRow.parse({
  id: 'bb20bf396af0e32e6835fcc0379e5741250288abc8add35343fd4abbcff9cc8e',
  severity: 'notable',
  headline: "Google's docs no longer position gemini-4-hydrogen as its balanced-class pick",
  explanation: `The google balanced-class recommendation for model_slug gemini-4-hydrogen, whose basis read "${OLD_BASIS}", flips from present to no longer present: that sentence is gone from Google's own docs.`,
  change_ids: JSON.stringify([CHANGE.id]),
  rule: 'agent-judge',
  created_at: '2026-11-18T21:00:59.601Z',
  source_url: 'https://aistudio.google.com/docs/models.md',
  fetched_at: '2026-11-18T21:00:59.601Z',
})

/** The file's statements, as wrangler applies them. */
async function runMigration() {
  const statements = migration
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)))
}

const stored = async () => (await db.select().from(schema.alerts))[0]

describe('migration 0053: the alert on Google’s shortened Hydrogen sentence', () => {
  beforeEach(async () => {
    await db.delete(schema.alerts)
  })

  it('says the sentence was shortened and the mapping kept its model', async () => {
    await insertRows(db, 'alerts', [RECORDED])
    await runMigration()
    const alert = await stored()
    expect(alert).toMatchObject({
      id: RECORDED.id,
      severity: 'info',
      headline: 'Google shortens the sentence the price matrix quotes for gemini-4-hydrogen',
      rule: 'agent-judge',
      change_ids: RECORDED.change_ids,
      created_at: RECORDED.created_at,
      source_url: RECORDED.source_url,
      fetched_at: RECORDED.fetched_at,
    })
    expect(alert!.explanation).toContain('gemini-4-hydrogen is still the model we show')
    expect(alert!.headline).not.toContain('no longer')
  })

  it('stays inside the change row the alert cites', async () => {
    await insertRows(db, 'alerts', [RECORDED])
    await runMigration()
    const alert = await stored()
    expect(
      groundingFailure(`${alert!.headline}\n${alert!.explanation}`, corpusOf([CHANGE])),
    ).toBeNull()
  })

  it('stores the severity the rewording gate gives the same alert', () => {
    const requoted = new Set([
      requotedKey({ provider: 'google', class: 'balanced', model_slug: 'gemini-4-hydrogen' }),
    ])
    const sent = {
      severity: RECORDED.severity,
      headline: RECORDED.headline,
      change_ids: [CHANGE.id],
    }
    const { alerts } = clampRoutineAlerts([sent], [CHANGE], new Set(), new Set(), requoted)
    expect(alerts[0]!.severity).toBe('info')
  })

  it('touches nothing when the alert is absent, reworded already, or another alert', async () => {
    await runMigration()
    expect(await db.select().from(schema.alerts)).toEqual([])

    const other = { ...RECORDED, headline: 'Some other headline under the same id' }
    await insertRows(db, 'alerts', [other])
    await runMigration()
    expect(await stored()).toMatchObject({ headline: other.headline, severity: 'notable' })

    await db.delete(schema.alerts)
    await insertRows(db, 'alerts', [RECORDED])
    await runMigration()
    const once = await db.select().from(schema.alerts)
    await runMigration()
    expect(await db.select().from(schema.alerts)).toEqual(once)
  })
})
