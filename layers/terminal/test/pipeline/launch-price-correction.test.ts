import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import migration from '~~/server/db/migrations/0050_correct_google_launch_prices.sql?raw'
import { AlertRow, ChangeRow } from '../../server/pipeline/contracts'
import { addedModels, modelFloorAlert } from '../../server/pipeline/model-floor'
import { insertRows } from '../../server/pipeline/store'
import { fixtureText } from './fixtures'

// A launch alert's price is the model's list price. Until 2026-11-11 the
// model-floor rule priced it off the untiered row, else the first row parsed;
// Google's parser names its list tier 'standard', so five Google launches were
// announced at their batch price. The records here are those five alerts and
// the change rows each cites, copied from production (/api/alerts and
// /export/changes.json) into fixtures/alerts/google-launch-alerts.json.

const db = drizzle(env.DB, { schema })

interface Recorded {
  alert: Omit<AlertRow, 'change_ids'> & { change_ids: string[] }
  changes: unknown[]
}
const RECORDED = JSON.parse(fixtureText('fixtures/alerts/google-launch-alerts.json')) as Recorded[]

const original = (r: Recorded) =>
  AlertRow.parse({ ...r.alert, change_ids: JSON.stringify(r.alert.change_ids) })
const rebuilt = (r: Recorded) => {
  const groups = addedModels(r.changes.map((c) => ChangeRow.parse(c)))
  expect(groups).toHaveLength(1)
  return modelFloorAlert(groups[0]!)
}

/** Every UPDATE in the file, as wrangler applies them: one statement per breakpoint. */
async function runMigration() {
  const statements = migration
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)))
}

const CARBON = RECORDED.find((r) => r.alert.headline.includes('gemini-4-carbon'))!

describe('the price on a launch alert', () => {
  it('is the standard tier in effect, whichever row the parser emitted first', () => {
    // The first cited row is batch at $1.00 / $5.00; the list price is $2.00 / $10.00.
    expect(ChangeRow.parse(CARBON.changes[0]).entity_key).toBe('model:google:gemini-4-carbon:batch')
    const alert = rebuilt(CARBON)
    expect(alert.headline).toBe(
      'Google lists a new model, gemini-4-carbon — $2.00 in / $10.00 out per MTok',
    )
    expect(alert.explanation).toContain(
      'Its standard price moves to $4.00 in / $20.00 out per MTok on 2026-12-01.',
    )
    expect(alert.explanation).toContain('listed as batch, contributor, flex, priority, standard.')
  })

  it('is left out when no standard row is listed, rather than quoting another tier', () => {
    const batchOnly = CARBON.changes.filter(
      (c) => !ChangeRow.parse(c).entity_key.includes(':standard'),
    )
    const [group] = addedModels(batchOnly.map((c) => ChangeRow.parse(c)))
    expect(modelFloorAlert(group!).headline).toBe('Google lists a new model, gemini-4-carbon')
  })
})

describe('migration 0050: the five Google launch alerts', () => {
  beforeEach(async () => {
    await db.delete(schema.alerts)
  })

  it('writes exactly what the fixed rule writes from each alert’s own cited rows', async () => {
    expect(RECORDED).toHaveLength(5)
    await insertRows(db, 'alerts', RECORDED.map(original))
    await runMigration()
    for (const r of RECORDED) {
      const expected = rebuilt(r)
      expect(expected.id).toBe(r.alert.id)
      expect(expected.headline).not.toBe(r.alert.headline)
      const [stored] = await db.select().from(schema.alerts).where(eq(schema.alerts.id, r.alert.id))
      expect(stored).toMatchObject({
        headline: expected.headline,
        explanation: expected.explanation,
        severity: r.alert.severity,
        rule: 'model-floor',
        change_ids: JSON.stringify(r.alert.change_ids),
        created_at: r.alert.created_at,
        source_url: r.alert.source_url,
        fetched_at: r.alert.fetched_at,
      })
    }
  })

  it('touches nothing when the alerts are absent or already corrected', async () => {
    await runMigration()
    expect(await db.select().from(schema.alerts)).toEqual([])
    await insertRows(db, 'alerts', RECORDED.map(original))
    await runMigration()
    const once = await db.select().from(schema.alerts)
    await runMigration()
    expect(await db.select().from(schema.alerts)).toEqual(once)
  })
})
