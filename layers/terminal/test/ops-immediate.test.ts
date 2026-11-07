// A critical ops event is mailed when it is spooled, not up to 30 minutes
// later; a failing site that spools a 5xx per request still sends one email.

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
  classifyOps,
  registerOpsSeverity,
  resetOpsSeverityForTest,
} from '~~/server/utils/ops-severity'
import { SERVER_ERROR_CRITICAL_COUNT } from '~~/server/utils/ops-severity'
import {
  BURST_CHECK_INTERVAL_MS,
  OPS_IMMEDIATE_CLAIM_KEY,
  OPS_IMMEDIATE_INTERVAL_SECONDS,
  notifyIfCritical,
  resetOpsImmediateForTest,
  type ImmediateDeps,
} from '../server/utils/ops-immediate'
import type { CacheStore } from '../server/utils/terminal-cache'

const db = drizzle(env.DB, { schema })

function harness(overrides: Partial<ImmediateDeps> = {}) {
  const sent: OpsDigest[] = []
  const map = new Map<string, unknown>()
  const ttls = new Map<string, number | undefined>()
  const store: CacheStore = {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value, opts) => {
      map.set(key, value)
      ttls.set(key, opts?.ttl)
    },
  }
  let clock = Date.parse('2026-11-07T12:00:00Z')
  const deps: ImmediateDeps = {
    classify: classifyOps,
    mailer: async (d) => void sent.push(d),
    store,
    options: { appName: 'Frontier Terminal' },
    now: () => clock,
    ...overrides,
  }
  return { deps, sent, map, ttls, advance: (ms: number) => (clock += ms) }
}

beforeEach(async () => {
  await db.delete(schema.opsEvents)
  resetOpsSeverityForTest()
  resetOpsEventListenersForTest()
  resetOpsImmediateForTest()
  registerOpsSeverity({ all_sources_failed: { severity: 'critical' } })
})

describe('notifyIfCritical', () => {
  it('mails a registered critical kind at once and marks the rows', async () => {
    const { deps, sent, ttls } = harness()
    await recordOpsEvent(db, { kind: 'all_sources_failed', detail: 'survey: all 40 failed' })

    expect(await notifyIfCritical(db, { kind: 'all_sources_failed' }, deps)).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toContain('[Critical]')
    const rows = await db.select().from(schema.opsEvents)
    expect(rows.every((r) => r.notifiedAt !== null)).toBe(true)
    expect(ttls.get(OPS_IMMEDIATE_CLAIM_KEY)).toBe(OPS_IMMEDIATE_INTERVAL_SECONDS)
  })

  it('leaves warnings to the digest', async () => {
    const { deps, sent } = harness()
    await recordOpsEvent(db, { kind: 'source_failed' })
    expect(await notifyIfCritical(db, { kind: 'source_failed' }, deps)).toBe('not-critical')
    expect(sent).toHaveLength(0)
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

  it('sends one immediate digest per interval across isolates', async () => {
    const { deps, sent, map } = harness()
    map.set(OPS_IMMEDIATE_CLAIM_KEY, true)
    await recordOpsEvent(db, { kind: 'all_sources_failed' })
    expect(await notifyIfCritical(db, { kind: 'all_sources_failed' }, deps)).toBe('throttled')
    expect(sent).toHaveLength(0)
    const rows = await db.select().from(schema.opsEvents)
    expect(rows.every((r) => r.notifiedAt === null)).toBe(true)
  })

  it('does nothing without a mailer, leaving the row for the cron', async () => {
    const { deps } = harness({ mailer: null })
    await recordOpsEvent(db, { kind: 'all_sources_failed' })
    expect(await notifyIfCritical(db, { kind: 'all_sources_failed' }, deps)).toBe('unconfigured')
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
