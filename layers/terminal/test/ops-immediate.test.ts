// A critical ops event is mailed when it is spooled, once per kind per
// cooldown; warnings stay pending for the daily digest.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { OpsDigest } from '~~/server/utils/ops'
import {
  onOpsEventRecorded,
  recordOpsEvent,
  resetOpsEventListenersForTest,
} from '~~/server/utils/ops'
import {
  SERVER_ERROR_CRITICAL_COUNT,
  classifyOps,
  registerOpsSeverity,
  resetOpsSeverityForTest,
} from '~~/server/utils/ops-severity'
import {
  BURST_CHECK_INTERVAL_MS,
  notifyIfCritical,
  resetOpsImmediateForTest,
  type ImmediateDeps,
} from '../server/utils/ops-immediate'
import { CRITICAL_COOLDOWN_MS } from '../server/utils/ops-throttle'

const db = drizzle(env.DB, { schema })

function harness(overrides: Partial<ImmediateDeps> = {}) {
  const sent: OpsDigest[] = []
  let failNext = false
  let clock = Date.parse('2026-11-07T12:00:00Z')
  const deps: ImmediateDeps = {
    classify: classifyOps,
    mailer: async (d) => {
      if (failNext) {
        failNext = false
        throw new Error('binding down')
      }
      sent.push(d)
    },
    options: { appName: 'Frontier Terminal' },
    now: () => clock,
    ...overrides,
  }
  return {
    deps,
    sent,
    advance: (ms: number) => (clock += ms),
    failNextSend: () => (failNext = true),
  }
}

async function pendingKinds() {
  const rows = await db.select().from(schema.opsEvents)
  return rows.filter((r) => r.notifiedAt === null).map((r) => r.kind)
}

beforeEach(async () => {
  await db.delete(schema.opsEvents)
  await db.delete(schema.opsAlertState)
  resetOpsSeverityForTest()
  resetOpsEventListenersForTest()
  resetOpsImmediateForTest()
  registerOpsSeverity({
    all_sources_failed: { severity: 'critical' },
    workers_issue: { severity: 'critical' },
  })
})

describe('notifyIfCritical', () => {
  it('mails a critical kind at once, carrying only critical rows', async () => {
    const { deps, sent } = harness()
    await recordOpsEvent(db, { kind: 'source_failed', detail: 'a: HTTP 403' })
    await recordOpsEvent(db, { kind: 'all_sources_failed', detail: 'survey: all 40 failed' })

    expect(await notifyIfCritical(db, { kind: 'all_sources_failed' }, deps)).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toContain('[Critical]')
    expect(sent[0]!.text).not.toContain('Source failed')
    expect(await pendingKinds()).toEqual(['source_failed'])
  })

  it('leaves warnings to the daily digest', async () => {
    const { deps, sent } = harness()
    await recordOpsEvent(db, { kind: 'source_failed' })
    expect(await notifyIfCritical(db, { kind: 'source_failed' }, deps)).toBe('not-critical')
    expect(sent).toHaveLength(0)
  })

  it('dedupes repeats of one kind inside the cooldown, then mails again', async () => {
    const { deps, sent, advance } = harness()
    await recordOpsEvent(db, { kind: 'workers_issue', detail: 'first' })
    expect(await notifyIfCritical(db, { kind: 'workers_issue' }, deps)).toBe('sent')

    for (const detail of ['second', 'third']) {
      advance(10 * 60_000)
      await recordOpsEvent(db, { kind: 'workers_issue', detail })
      expect(await notifyIfCritical(db, { kind: 'workers_issue' }, deps)).toBe('repeat')
    }
    expect(sent).toHaveLength(1)
    // Settled, so neither the tick nor the daily digest mails them later.
    expect(await pendingKinds()).toEqual([])

    advance(CRITICAL_COOLDOWN_MS)
    await recordOpsEvent(db, { kind: 'workers_issue', detail: 'next day' })
    expect(await notifyIfCritical(db, { kind: 'workers_issue' }, deps)).toBe('sent')
    expect(sent).toHaveLength(2)
  })

  it('keeps a separate cooldown per kind', async () => {
    const { deps, sent } = harness()
    await recordOpsEvent(db, { kind: 'workers_issue' })
    expect(await notifyIfCritical(db, { kind: 'workers_issue' }, deps)).toBe('sent')
    await recordOpsEvent(db, { kind: 'all_sources_failed' })
    expect(await notifyIfCritical(db, { kind: 'all_sources_failed' }, deps)).toBe('sent')
    expect(sent).toHaveLength(2)
  })

  it('releases the claim when the send fails, so the next try mails', async () => {
    const { deps, sent, failNextSend } = harness()
    await recordOpsEvent(db, { kind: 'workers_issue' })
    failNextSend()
    expect(await notifyIfCritical(db, { kind: 'workers_issue' }, deps)).toBe('send-failed')
    expect(await pendingKinds()).toEqual(['workers_issue'])
    expect(await notifyIfCritical(db, { kind: 'workers_issue' }, deps)).toBe('sent')
    expect(sent).toHaveLength(1)
  })

  it('treats a 5xx burst as critical, and counts at most once a minute', async () => {
    const { deps, sent, advance } = harness()
    for (let i = 0; i < SERVER_ERROR_CRITICAL_COUNT - 1; i++) {
      await recordOpsEvent(db, { kind: 'server_error', path: `/x/${i}` })
    }
    expect(await notifyIfCritical(db, { kind: 'server_error' }, deps)).toBe('not-critical')

    await recordOpsEvent(db, { kind: 'server_error', path: '/x/last' })
    // Inside the minute: no second count, so no send yet.
    expect(await notifyIfCritical(db, { kind: 'server_error' }, deps)).toBe('not-critical')

    advance(BURST_CHECK_INTERVAL_MS)
    expect(await notifyIfCritical(db, { kind: 'server_error' }, deps)).toBe('sent')
    expect(sent).toHaveLength(1)
  })

  it('does nothing without a mailer, leaving the row for the cron', async () => {
    const { deps } = harness({ mailer: null })
    await recordOpsEvent(db, { kind: 'all_sources_failed' })
    expect(await notifyIfCritical(db, { kind: 'all_sources_failed' }, deps)).toBe('unconfigured')
    expect(await pendingKinds()).toEqual(['all_sources_failed'])
  })
})

describe('onOpsEventRecorded', () => {
  it('runs after the row is written, and a throwing listener never reaches the caller', async () => {
    const seen: string[] = []
    onOpsEventRecorded(async (_db, input) => {
      const rows = await db.select().from(schema.opsEvents)
      seen.push(`${input.kind}:${rows.length}`)
    })
    onOpsEventRecorded(async () => {
      throw new Error('mail binding down')
    })
    await expect(recordOpsEvent(db, { kind: 'server_error' })).resolves.toBeUndefined()
    expect(seen).toEqual(['server_error:1'])
  })
})
