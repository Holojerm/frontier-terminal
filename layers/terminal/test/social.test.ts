// What Frontier Terminal queues for its social accounts, against a real D1.
// Sending is the social layer's (layers/social/test); this pins down what is
// offered: critical alerts only, from go-live on, judged ones held, and a
// weekly thread built from counts and headlines alone.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { socialLength } from '#layers/social/server/utils/social-text'
import {
  composeWeeklyDigest,
  enqueueCriticalAlerts,
  enqueueWeeklyDigest,
  JUDGED_HOLD_MS,
  SOCIAL_EPOCH,
} from '../server/pipeline/social'

const db = drizzle(env.DB, { schema })

const ORIGIN = 'https://frontierterm.com'
const CHANNELS = { x: 'chan-x' }
const NOW = new Date('2026-11-09T13:00:00.000Z')

function alert(
  id: string,
  severity: string,
  rule: string,
  created_at: string,
  headline = `Headline ${id}`,
) {
  return {
    id,
    severity,
    headline,
    explanation: 'e',
    change_ids: '[]',
    rule,
    created_at,
    source_url: 'https://example.com',
    fetched_at: created_at,
  }
}

function change(id: string, entity_type: string, detected_at: string) {
  return {
    id,
    entity_key: id,
    entity_type,
    provider: 'openai',
    change_type: 'added',
    detected_at,
    source_url: 'https://example.com',
    fetched_at: detected_at,
  }
}

beforeEach(async () => {
  await db.delete(schema.socialPosts)
  await db.delete(schema.alerts)
  await db.delete(schema.changes)
})

describe('enqueueCriticalAlerts', () => {
  it('queues criticals since go-live only, holding judged ones', async () => {
    await db
      .insert(schema.alerts)
      .values([
        alert('rule', 'critical', 's1-floor', '2026-11-05T10:00:00.000Z'),
        alert('judged', 'critical', 'agent-judge', '2026-11-05T11:00:00.000Z'),
        alert('notable', 'notable', 'agent-judge', '2026-11-05T12:00:00.000Z'),
        alert('old', 'critical', 's1-floor', '2026-10-01T00:00:00.000Z'),
      ])
    expect(await enqueueCriticalAlerts(db, CHANNELS, ORIGIN)).toBe(2)
    expect(await enqueueCriticalAlerts(db, CHANNELS, ORIGIN)).toBe(0)

    const rows = await db.select().from(schema.socialPosts)
    const byRef = Object.fromEntries(rows.map((r) => [r.ref, r]))
    expect(Object.keys(byRef).sort()).toEqual(['judged', 'rule'])
    expect(byRef.rule!.notBefore.toISOString()).toBe('2026-11-05T10:00:00.000Z')
    expect(byRef.judged!.notBefore.getTime()).toBe(
      Date.parse('2026-11-05T11:00:00.000Z') + JUDGED_HOLD_MS,
    )
    expect(JSON.parse(byRef.rule!.body)).toEqual({
      posts: [`Headline rule ${ORIGIN}/alerts/rule`],
    })
  })

  it('keeps a long headline inside the limit, link intact', async () => {
    const long = 'OpenAI files an S-1 '.repeat(30).trim()
    await db
      .insert(schema.alerts)
      .values(alert('long', 'critical', 's1-floor', '2026-11-05T10:00:00.000Z', long))
    await enqueueCriticalAlerts(db, CHANNELS, ORIGIN)
    const [row] = await db.select().from(schema.socialPosts)
    const [text] = JSON.parse(row!.body).posts as string[]
    expect(socialLength('x', text!)).toBeLessThanOrEqual(280)
    expect(text!.endsWith(`… ${ORIGIN}/alerts/long`)).toBe(true)
  })

  it('treats the epoch as inclusive', async () => {
    await db.insert(schema.alerts).values(alert('edge', 'critical', 's1-floor', SOCIAL_EPOCH))
    expect(await enqueueCriticalAlerts(db, CHANNELS, ORIGIN)).toBe(1)
  })
})

describe('weekly digest', () => {
  it('counts the week by axis, skips rankings, and names criticals', async () => {
    await db
      .insert(schema.changes)
      .values([
        change('c1', 'model', '2026-11-08T00:00:00.000Z'),
        change('c2', 'job', '2026-11-07T00:00:00.000Z'),
        change('c3', 'job', '2026-11-06T00:00:00.000Z'),
        change('c4', 'ranking', '2026-11-06T00:00:00.000Z'),
        change('c5', 'model', '2026-10-20T00:00:00.000Z'),
      ])
    await db
      .insert(schema.alerts)
      .values([
        alert('a1', 'critical', 's1-floor', '2026-11-08T00:00:00.000Z'),
        alert('a2', 'notable', 'agent-judge', '2026-11-08T00:00:00.000Z'),
      ])
    expect(await enqueueWeeklyDigest(db, CHANNELS, ORIGIN, NOW)).toBe(1)
    expect(await enqueueWeeklyDigest(db, CHANNELS, ORIGIN, NOW)).toBe(0)

    const [row] = await db.select().from(schema.socialPosts)
    expect(row).toMatchObject({ kind: 'digest', ref: '2026-11-09' })
    expect(JSON.parse(row!.body).posts).toEqual([
      `The frontier labs, week to Nov 9: 3 tracked changes.\n\nPricing 1 · Hiring 2\n\nAlerts: 1 critical alert, 1 notable. ${ORIGIN}/alerts`,
      `Headline a1 ${ORIGIN}/alerts/a1`,
    ])
  })

  it('posts nothing for an empty week', async () => {
    expect(await enqueueWeeklyDigest(db, CHANNELS, ORIGIN, NOW)).toBe(0)
    expect(
      composeWeeklyDigest(
        'x',
        {
          weekTo: NOW,
          counts: { pricing: 0, hiring: 0, sec: 0, incidents: 0, disclosures: 0 },
          total: 0,
          criticals: [],
          notable: 0,
        },
        ORIGIN,
      ),
    ).toBeNull()
  })
})
