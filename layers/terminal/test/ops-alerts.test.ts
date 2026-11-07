// The daily digest against a real D1: once a day, once per failure streak,
// nothing on a quiet day, and every pending row settled either way.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { OpsDigest } from '~~/server/utils/ops'
import {
  classifyOps,
  registerOpsSeverity,
  resetOpsSeverityForTest,
} from '~~/server/utils/ops-severity'
import { runDailyDigest, sendCriticalAlerts, type OpsAlertDeps } from '../server/utils/ops-alerts'
import { TERMINAL_OPS_SEVERITY } from '../server/utils/terminal-ops-severity'

const db = drizzle(env.DB, { schema })
const HOUR = 60 * 60 * 1000
const DAY1 = Date.parse('2026-11-07T13:00:00Z')

let sent: OpsDigest[] = []
let failSend = false
const deps = (at: number): OpsAlertDeps => ({
  classify: classifyOps,
  mailer: async (d) => {
    if (failSend) throw new Error('binding down')
    sent.push(d)
  },
  options: { appName: 'Frontier Terminal' },
  now: new Date(at),
})

async function spool(kind: string, detail: string, at: number) {
  await db.insert(schema.opsEvents).values({ kind, detail, createdAt: new Date(at) })
}

/** One poll per 30 minutes between two times, failing the same way each run. */
async function failEveryTick(kind: string, detail: string, from: number, to: number) {
  for (let at = from; at <= to; at += HOUR / 2) await spool(kind, detail, at)
}

async function pending() {
  const rows = await db.select().from(schema.opsEvents)
  return rows.filter((r) => r.notifiedAt === null).length
}

beforeEach(async () => {
  await db.delete(schema.opsEvents)
  await db.delete(schema.opsAlertState)
  resetOpsSeverityForTest()
  registerOpsSeverity(TERMINAL_OPS_SEVERITY)
  sent = []
  failSend = false
})

describe('runDailyDigest', () => {
  it('waits for the digest hour, then runs once that day', async () => {
    await spool('bulk_build_failed', 'x: Unexpected end of file', DAY1 - 5 * HOUR)
    expect(await runDailyDigest(db, deps(DAY1 - HOUR))).toEqual({ due: false })
    expect(await pending()).toBe(1)

    expect(await runDailyDigest(db, deps(DAY1))).toMatchObject({
      due: true,
      sent: true,
      settled: 1,
    })
    expect(sent[0]!.subject).toMatch(/^\[Warning\] Frontier Terminal · Bulk build failed ×1/)
    expect(await pending()).toBe(0)

    await spool('bulk_build_failed', 'y: other', DAY1 + HOUR)
    expect(await runDailyDigest(db, deps(DAY1 + 2 * HOUR))).toEqual({ due: false })
    expect(sent).toHaveLength(1)
  })

  it('mails nothing on a quiet day, and settles held-back rows anyway', async () => {
    // An npm 429 that cleared after two hours: below the transient threshold.
    await failEveryTick(
      'recipe_failed',
      'npm-codex: HTTP 429 (Retry-After 0s) after 3 attempts',
      DAY1 - 4 * HOUR,
      DAY1 - 2 * HOUR,
    )
    await spool('judge_rejected', 'claim not grounded', DAY1 - 3 * HOUR)
    expect(await runDailyDigest(db, deps(DAY1))).toMatchObject({
      due: true,
      sent: false,
      settled: 6,
    })
    expect(sent).toHaveLength(0)
    expect(await pending()).toBe(0)
  })

  it('reports a persistent 403 once after six hours, then stays quiet until it recovers', async () => {
    const detail = 'edgar-submissions-amzn: HTTP 403'
    // Day 0 13:00 → day 1 13:00: failing every tick since 20:00.
    await failEveryTick('source_failed', detail, DAY1 - 17 * HOUR, DAY1 - HOUR / 2)
    await runDailyDigest(db, deps(DAY1))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain(detail)

    // Day 2: still failing every tick. No email.
    await failEveryTick('source_failed', detail, DAY1 + HOUR / 2, DAY1 + 23 * HOUR)
    await runDailyDigest(db, deps(DAY1 + 24 * HOUR))
    expect(sent).toHaveLength(1)

    // Day 3: quiet for a day. The next digest a new failure sends notes the
    // recovery alongside it.
    await spool('bulk_build_failed', 'z: Unexpected end of file', DAY1 + 47 * HOUR)
    await runDailyDigest(db, deps(DAY1 + 48 * HOUR + HOUR))
    expect(sent).toHaveLength(2)
    expect(sent[1]!.text).toContain('Ops recovered')
    expect(sent[1]!.text).toContain(detail)
    const state = await db.select().from(schema.opsAlertState)
    expect(state.map((s) => s.key).filter((k) => k.includes('amzn'))).toEqual([])
  })

  it('leaves everything pending when the send fails, and retries on the next tick', async () => {
    await spool('bulk_build_failed', 'x: Unexpected end of file', DAY1 - HOUR)
    failSend = true
    expect(await runDailyDigest(db, deps(DAY1))).toMatchObject({ due: true, sent: false })
    expect(await pending()).toBe(1)
    failSend = false
    expect(await runDailyDigest(db, deps(DAY1 + HOUR / 2))).toMatchObject({ sent: true })
    expect(sent).toHaveLength(1)
  })

  it('leaves critical rows to the critical path', async () => {
    await spool('workers_issue', 'new failure', DAY1 - HOUR)
    await spool('bulk_build_failed', 'x: Unexpected end of file', DAY1 - HOUR)
    await runDailyDigest(db, deps(DAY1))
    expect(sent[0]!.text).not.toContain('Workers issue')
    expect(await pending()).toBe(1)
    expect((await sendCriticalAlerts(db, deps(DAY1))).sent).toEqual(['workers_issue'])
    expect(await pending()).toBe(0)
  })
})

describe('a week like the one before this change', () => {
  it('sends a handful of emails, not one per half hour', async () => {
    // The repeating warnings from production, 2026-10-31 to 11-07: EDGAR and
    // OpenAI 403s and an unparseable page on every survey, an npm 429 and a
    // track-record 522 once a day, judge rejections, and a Workers Issue that
    // fired five times in forty minutes.
    const start = DAY1 - 7 * 24 * HOUR
    const events: [number, string, string][] = []
    for (let day = 0; day < 7; day++) {
      const base = start + day * 24 * HOUR
      for (let h = 0; h < 24; h += 6) {
        events.push([base + h * HOUR, 'source_failed', 'edgar-submissions-amzn: HTTP 403'])
        events.push([base + h * HOUR, 'source_failed', 'openai-models-md: HTTP 403'])
        events.push([base + h * HOUR, 'source_failed', 'meta-models-md: no table found'])
      }
      events.push([
        base + 2 * HOUR,
        'recipe_failed',
        'npm-codex: HTTP 429 (Retry-After 0s) after 3 attempts',
      ])
      events.push([
        base + 3 * HOUR,
        'track_record_search_failed',
        `GDELT search for alert ${'ab'.repeat(16)}${day}: HTTP 522 after 1 attempts`,
      ])
      events.push([base + 4 * HOUR, 'judge_rejected', `claim ${day} not grounded`])
    }
    for (let i = 0; i < 5; i++)
      events.push([start + 50 * HOUR + i * 10 * 60_000, 'workers_issue', `issue ${i}`])
    events.sort((a, b) => a[0] - b[0])

    const subjects: string[] = []
    for (let at = start; at < DAY1 + 24 * HOUR; at += HOUR / 2) {
      while (events.length && events[0]![0] <= at) {
        const [when, kind, detail] = events.shift()!
        await spool(kind, detail, when)
        // As in production, a critical row is mailed the moment it lands.
        await sendCriticalAlerts(db, deps(when))
      }
      await sendCriticalAlerts(db, deps(at))
      await runDailyDigest(db, deps(at))
    }
    for (const d of sent) subjects.push(d.subject)

    // Eight digest slots and 197 rows: one Workers Issue email, a digest the
    // day each streak becomes reportable, then silence.
    expect(subjects).toEqual([
      '[Warning] Frontier Terminal · Source failed ×1',
      '[Warning] Frontier Terminal · Source failed ×8 + 1 more',
      '[Warning] Frontier Terminal · Recipe failed ×1 + 1 more',
      '[Critical] Frontier Terminal · Workers issue ×1',
    ])
  })
})
