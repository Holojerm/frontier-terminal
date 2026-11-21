import { env } from 'cloudflare:test'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { countedTotals, countsByKey } from '../server/utils/row-counts'

// row_counts and alert_cites are written by triggers (migration 0060), never
// by the pipeline. These write the counted tables the ways the writers do
// (insert, upsert, insert-or-ignore, delete) and hold the derived rows to what
// a count(*) or a walk of change_ids would say. The tests share one store, so
// each uses its own ids.

const db = drizzle(env.DB, { schema })
const AT = '2026-08-22T12:00:00.000Z'
const prov = { source_url: 'https://example.com/a', fetched_at: AT }

const entity = (source_id: string, entity_key: string) => ({
  source_id,
  entity_key,
  entity_type: 'job',
  provider: 'openai',
  content_hash: 'h1',
  payload: '{}',
  snapshot_id: 's1',
  first_seen_at: AT,
  ...prov,
})

const change = (id: string, provider: string, entity_type: string) => ({
  id,
  entity_key: `${entity_type}:${id}`,
  entity_type,
  provider,
  change_type: 'added',
  detected_at: AT,
  ...prov,
})

const alert = (id: string, changeIds: string[]) => ({
  id,
  severity: 'notable',
  headline: 'h',
  explanation: 'e',
  change_ids: JSON.stringify(changeIds),
  rule: 'r',
  created_at: AT,
  ...prov,
})

async function scanned(table: 'entities' | 'changes', key: 'source_id' | 'entity_type') {
  const { results } = await env.DB.prepare(
    `select ${key} as key, count(*) as n from ${table} group by ${key}`,
  ).all<{ key: string; n: number }>()
  return new Map(results.map((r) => [r.key, r.n]))
}

describe('row_counts follows every kind of write', () => {
  it('entities: inserts count, an upsert of a stored row does not, a delete uncounts', async () => {
    await db.insert(schema.entities).values([entity('a', '1'), entity('a', '2'), entity('b', '1')])
    await db
      .insert(schema.entities)
      .values(entity('a', '1'))
      .onConflictDoUpdate({
        target: [schema.entities.source_id, schema.entities.entity_key],
        set: { content_hash: 'h2' },
      })
    expect(await countsByKey(db, 'entities')).toEqual(await scanned('entities', 'source_id'))
    expect((await countedTotals(db)).entities).toBe(3)

    await db
      .delete(schema.entities)
      .where(and(eq(schema.entities.source_id, 'a'), eq(schema.entities.entity_key, '2')))
    await db.delete(schema.entities).where(eq(schema.entities.source_id, 'b'))
    // A source whose rows are all gone is left out, as a GROUP BY leaves it out.
    expect(await countsByKey(db, 'entities')).toEqual(new Map([['a', 1]]))
    expect(await countsByKey(db, 'entities')).toEqual(await scanned('entities', 'source_id'))
  })

  it('changes: a change id already logged is ignored and not counted twice', async () => {
    await db
      .insert(schema.changes)
      .values([change('c1', 'openai', 'model'), change('c2', 'anthropic', 'job')])
    await db
      .insert(schema.changes)
      .values(change('c1', 'openai', 'model'))
      .onConflictDoNothing()
    expect(await countsByKey(db, 'changes')).toEqual(await scanned('changes', 'entity_type'))
    expect((await countedTotals(db)).changes).toBe(2)
  })

  it('alerts: counted once, and cited under each lab and entity type its changes carry', async () => {
    await db
      .insert(schema.changes)
      .values([
        change('d1', 'openai', 'model'),
        change('d2', 'anthropic', 'job'),
        change('d3', 'anthropic', 'job'),
      ])
    await db.insert(schema.alerts).values(alert('a1', ['d1', 'd2', 'd3']))
    await db
      .insert(schema.alerts)
      .values(alert('a1', ['d1']))
      .onConflictDoNothing()
    // An alert citing nothing we stored is counted and matches no lab.
    await db.insert(schema.alerts).values(alert('a2', ['gone']))

    expect((await countedTotals(db)).alerts).toBe(2)
    const cites = await db
      .select()
      .from(schema.alertCites)
      .orderBy(sql`${schema.alertCites.provider}`)
    expect(cites).toEqual([
      { alert_id: 'a1', provider: 'anthropic', entity_type: 'job' },
      { alert_id: 'a1', provider: 'openai', entity_type: 'model' },
    ])
  })
})
