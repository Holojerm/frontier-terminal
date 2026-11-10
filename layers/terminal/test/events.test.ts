// The EVENTS queue replaced the five-minute clock for alert delivery. What
// has to hold: a new alert reaches each outbox and its drain is scheduled for
// when the first row is due; a drain keeps itself scheduled only while work
// is owed; a lost message is caught by the hourly sweep; and a duplicate or
// unreadable message never does harm.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { SocialPublisher } from '#layers/social/server/utils/buffer'
import { JUDGED_HOLD_MS } from '../server/pipeline/social'
import { expiryAfter } from '../server/utils/api-key-token'
import { handleEventBatch, type QueueMessageLike } from '../server/utils/event-consumer'
import {
  FANOUT_SETTLE_SECONDS,
  PENDING_RECHECK_SECONDS,
  fanOutAlerts,
  runSocialDrain,
  runWebhookDrain,
  sweepEvents,
  type EventDeps,
  type PressDeps,
} from '../server/utils/event-work'
import {
  MAX_DELAY_SECONDS,
  delaySecondsUntil,
  emitEvent,
  scheduleDrain,
  scheduledKey,
  setEventSender,
  type EventMessage,
} from '../server/utils/events'
import type { MailMessage } from '../server/utils/resend'
import type { CacheStore } from '../server/utils/terminal-cache'
import { signingKeyId, type WebhookRequest } from '../server/utils/webhook-sign'

const db = drizzle(env.DB, { schema })
const NOW = new Date('2026-11-07T12:00:00.000Z')
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000)
const KEY = 'k'.repeat(40)
const ORIGIN = 'https://frontierterm.com'

interface Sent {
  type: EventMessage['type']
  delaySeconds: number | undefined
}

function queueFake(fail = false) {
  const sent: Sent[] = []
  setEventSender({
    send: async (body, options) => {
      if (fail) throw new Error('queue down')
      sent.push({ type: body.type, delaySeconds: options?.delaySeconds })
    },
  })
  return sent
}

function mapStore(): CacheStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value)
    },
  }
}

function socialPublisher() {
  const posts: string[][] = []
  const publisher: SocialPublisher = async ({ posts: p }) => {
    posts.push(p)
    return { status: 'sent', remoteId: `r${posts.length}` }
  }
  return { posts, publisher }
}

function webhookSender(status = 200) {
  const sent: WebhookRequest[] = []
  const send = async (request: WebhookRequest) => {
    sent.push(request)
    return status < 300
      ? { ok: true as const, status }
      : { ok: false as const, status, error: `HTTP ${status}` }
  }
  return { sent, send }
}

function deps(overrides: Partial<EventDeps> = {}, now = NOW): EventDeps {
  return {
    db,
    store: mapStore(),
    now: () => now,
    social: null,
    webhooks: null,
    press: null,
    record: async () => {},
    ...overrides,
  }
}

let alertN = 0
async function seedAlert(severity: string, opts: { rule?: string; created_at?: Date } = {}) {
  const id = (++alertN).toString(16).padStart(64, '0')
  const created_at = (opts.created_at ?? at(-30)).toISOString()
  const changeId = `c${id.slice(1)}`
  await db.insert(schema.changes).values({
    id: changeId,
    entity_key: `price:openai:${id}`,
    entity_type: 'price',
    provider: 'openai',
    change_type: 'modified',
    before_json: '{"p":1}',
    after_json: '{"p":2}',
    detected_at: created_at,
    source_url: 'https://openai.com/api/pricing',
    fetched_at: created_at,
  })
  await db.insert(schema.alerts).values({
    id,
    severity,
    headline: `Alert ${id.slice(-4)}`,
    explanation: 'p went from 1 to 2',
    change_ids: JSON.stringify([changeId]),
    rule: opts.rule ?? 'rule-x',
    created_at,
    source_url: 'https://openai.com/api/pricing',
    fetched_at: created_at,
    recorded_at: created_at,
  })
  return id
}

async function seedWebhook() {
  await db.insert(schema.apiKeys).values({
    id: 'key_00000000aa',
    key_hash: 'h'.repeat(64),
    client: 'Acme Capital',
    tier: 'research',
    issued_at: at(-86_400).toISOString(),
    expires_at: expiryAfter(at(-86_400), 12),
    revoked: false,
    revoked_at: null,
  })
  await db.insert(schema.webhooks).values({
    id: 'whk_000000000a',
    api_key_id: 'key_00000000aa',
    url: 'https://hooks.acme.example.org/a',
    min_severity: 'info',
    secret_hash: 'x',
    signing_key_id: await signingKeyId(KEY),
    status: 'active',
    created_at: at(-3600).toISOString(),
  })
}

const socialDeps = (publisher: SocialPublisher) => ({
  config: { apiKey: 'buf', channels: { x: 'chan-x' }, enabled: true },
  publisher,
  origin: ORIGIN,
})

const webhookDeps = (send: ReturnType<typeof webhookSender>['send'], stamp: Date) => ({
  signingKey: KEY,
  origin: ORIGIN,
  schemaVersion: '1.1.0',
  stamp: async () => stamp.toISOString(),
  send,
})

beforeEach(async () => {
  setEventSender(null)
  for (const table of [
    schema.webhookDeliveries,
    schema.webhooks,
    schema.apiKeys,
    schema.alerts,
    schema.changes,
    schema.socialPosts,
    schema.opsEvents,
  ]) {
    await db.delete(table)
  }
})

describe('emitEvent', () => {
  it('does nothing and reports unsent when no sender is installed', async () => {
    expect(await emitEvent('alerts.new')).toBe(false)
  })

  it('sends a versioned message, with the delay capped at what Queues accepts', async () => {
    const sent = queueFake()
    expect(await emitEvent('social.drain', 10 * MAX_DELAY_SECONDS)).toBe(true)
    expect(sent).toEqual([{ type: 'social.drain', delaySeconds: MAX_DELAY_SECONDS }])
  })

  it('never throws when the queue does: the write that called it already committed', async () => {
    queueFake(true)
    await expect(emitEvent('alerts.new')).resolves.toBe(false)
  })

  it('computes delays with a floor and nothing when nothing is due', () => {
    expect(delaySecondsUntil(null, NOW, 60)).toBeNull()
    expect(delaySecondsUntil(at(-100), NOW, 60)).toBe(60)
    expect(delaySecondsUntil(at(3600), NOW, 60)).toBe(3600)
  })
})

describe('scheduleDrain', () => {
  it('collapses drains already scheduled at or before the requested moment', async () => {
    const sent = queueFake()
    const store = mapStore()
    expect(await scheduleDrain(store, 'social.drain', 60, NOW)).toBe('scheduled')
    expect(await scheduleDrain(store, 'social.drain', 300, NOW)).toBe('already')
    // An earlier one is still worth sending.
    expect(await scheduleDrain(store, 'social.drain', 30, NOW)).toBe('scheduled')
    expect(sent.map((s) => s.delaySeconds)).toEqual([60, 30])
  })

  it('schedules again once the marked moment has passed, which is how a drain renews itself', async () => {
    const sent = queueFake()
    const store = mapStore()
    store.map.set(scheduledKey('webhooks.drain'), NOW.getTime() - 1)
    expect(await scheduleDrain(store, 'webhooks.drain', 300, NOW)).toBe('scheduled')
    expect(sent).toHaveLength(1)
  })
})

describe('fanOutAlerts', () => {
  it('queues a post per critical alert and schedules the drain after the settle time', async () => {
    const sent = queueFake()
    await seedAlert('critical')
    const { publisher } = socialPublisher()
    const result = await fanOutAlerts(deps({ social: socialDeps(publisher) }))
    expect(result.social).toBe(1)
    expect(sent).toEqual([{ type: 'social.drain', delaySeconds: FANOUT_SETTLE_SECONDS }])
  })

  it('schedules a judged alert’s drain for the end of its hold', async () => {
    const sent = queueFake()
    await seedAlert('critical', { rule: 'agent-judge', created_at: NOW })
    const { publisher } = socialPublisher()
    await fanOutAlerts(deps({ social: socialDeps(publisher) }))
    expect(sent).toEqual([{ type: 'social.drain', delaySeconds: JUDGED_HOLD_MS / 1000 }])
  })

  it('queues webhook deliveries and schedules their drain; unconfigured outboxes are skipped', async () => {
    const sent = queueFake()
    await seedWebhook()
    await seedAlert('notable')
    const { send } = webhookSender()
    const result = await fanOutAlerts(deps({ webhooks: webhookDeps(send, at(120)) }))
    expect(result).toEqual({ social: null, webhooks: 1, press: null })
    expect(sent).toEqual([{ type: 'webhooks.drain', delaySeconds: FANOUT_SETTLE_SECONDS }])
  })

  const REPORTERS = [
    { name: 'A Reporter', outlet: 'Wire', email: 'a@example.org', priority: 1 },
    { name: 'Tips', outlet: 'Paper', tips_email: 'tips@example.org', priority: 2 },
  ]
  const pressDeps = (send: PressDeps['send'], mails: string[] = []): PressDeps => ({
    contacts: REPORTERS,
    mailer: async (m) => void mails.push(m.subject),
    origin: ORIGIN,
    briefed: mapStore(),
    send,
    replyTo: 'owner@example.org',
  })

  it('without a sender, mails the owner one mailto brief per filing alert, once', async () => {
    queueFake()
    await seedAlert('critical', { rule: 'prospectus-floor' })
    const mails: string[] = []
    const d = deps({ press: pressDeps(null, mails) })
    expect((await fanOutAlerts(d)).press).toBe(1)
    expect((await fanOutAlerts(d)).press).toBe(0)
    expect(mails).toHaveLength(1)
    expect(mails[0]).toMatch(/^Press brief ready:/)
  })

  it('sends each reporter their note, once, and mails the owner a receipt', async () => {
    queueFake()
    await seedAlert('critical', { rule: 'prospectus-floor' })
    const notes: MailMessage[] = []
    const mails: string[] = []
    const d = deps({ press: pressDeps(async (m) => void notes.push(m), mails) })
    expect((await fanOutAlerts(d)).press).toBe(1)
    expect((await fanOutAlerts(d)).press).toBe(0)
    expect(notes.map((n) => [n.to, n.fromName, n.replyTo])).toEqual([
      ['a@example.org', 'Jeremy Ettlinger', 'owner@example.org'],
      ['tips@example.org', 'Jeremy Ettlinger', 'owner@example.org'],
    ])
    expect(notes[0]!.text).toMatch(/^Hi A,/)
    expect(notes[0]!.html).toContain(`<a href="${ORIGIN}/revenue">`)
    expect(mails).toEqual([expect.stringMatching(/^Press notes sent \(2\/2\):/)])
  })

  it('names a reporter it could not reach in the receipt and the spool, and moves on', async () => {
    queueFake()
    await seedAlert('critical', { rule: 'prospectus-floor' })
    const notes: string[] = []
    const mails: string[] = []
    const events: string[] = []
    const d = deps({
      press: pressDeps(async (m) => {
        if (m.to.startsWith('tips')) throw new Error('resend 422')
        notes.push(m.to)
      }, mails),
    })
    d.record = async (kind, detail) => void events.push(`${kind}: ${detail}`)
    expect((await fanOutAlerts(d)).press).toBe(1)
    expect((await fanOutAlerts(d)).press).toBe(0)
    expect(notes).toEqual(['a@example.org'])
    expect(mails).toEqual([expect.stringMatching(/^Press notes sent \(1\/2\):/)])
    expect(events).toEqual([expect.stringMatching(/^press_note_failed: .*Paper: resend 422$/)])
  })

  it('never mails a reporter twice when the receipt fails and the alert is retried', async () => {
    queueFake()
    await seedAlert('critical', { rule: 'prospectus-floor' })
    const notes: string[] = []
    let receipts = 0
    const d = deps({ press: pressDeps(async (m) => void notes.push(m.to)) })
    d.press!.mailer = async () => {
      if (receipts++ === 0) throw new Error('binding down')
    }
    expect((await fanOutAlerts(d)).press).toBe(0)
    expect((await fanOutAlerts(d)).press).toBe(1)
    expect(notes).toEqual(['a@example.org', 'tips@example.org'])
  })

  it('leaves the alert pending when no note went out, and spools why', async () => {
    queueFake()
    await seedAlert('critical', { rule: 'prospectus-floor' })
    const events: string[] = []
    const d = deps({
      press: pressDeps(async () => {
        throw new Error('resend 401')
      }),
    })
    d.record = async (kind, detail) => void events.push(`${kind}: ${detail}`)
    expect((await fanOutAlerts(d)).press).toBe(0)
    expect(events).toEqual([expect.stringContaining('no press note went out: resend 401')])
  })
})

describe('drains', () => {
  it('sends due posts and schedules nothing once the outbox is empty', async () => {
    const sent = queueFake()
    await seedAlert('critical', { created_at: at(-600) })
    const { posts, publisher } = socialPublisher()
    const d = deps({ social: socialDeps(publisher) })
    await fanOutAlerts(d)
    sent.length = 0
    expect(await runSocialDrain(d)).toEqual({ sent: 1, pending: false })
    expect(posts).toHaveLength(1)
    expect(sent).toEqual([])
  })

  it('renews itself while a post is still owed, at the post’s due time', async () => {
    const sent = queueFake()
    await seedAlert('critical', { rule: 'agent-judge', created_at: NOW })
    const { posts, publisher } = socialPublisher()
    const d = deps({ social: socialDeps(publisher) })
    await fanOutAlerts(d)
    sent.length = 0
    // Fresh store: the fan-out's marker would collapse the renewal.
    expect(await runSocialDrain({ ...d, store: mapStore() })).toEqual({ sent: 0, pending: true })
    expect(posts).toHaveLength(0)
    expect(sent).toEqual([{ type: 'social.drain', delaySeconds: JUDGED_HOLD_MS / 1000 }])
  })

  it('delivers a webhook once the stamp passes, and renews for a backoff retry', async () => {
    const sent = queueFake()
    await seedWebhook()
    await seedAlert('notable')
    const failing = webhookSender(500)
    await fanOutAlerts(deps({ webhooks: webhookDeps(failing.send, at(120)) }))
    sent.length = 0

    const later = at(120)
    const result = await runWebhookDrain(
      deps({ webhooks: webhookDeps(failing.send, later) }, later),
    )
    expect(failing.sent).toHaveLength(1)
    expect(result).toMatchObject({ retried: 1, pending: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.delaySeconds).toBeGreaterThanOrEqual(PENDING_RECHECK_SECONDS)

    const ok = webhookSender(200)
    const retryAt = at(120 + 86_400)
    const done = await runWebhookDrain(
      deps({ webhooks: webhookDeps(ok.send, retryAt), store: mapStore() }, retryAt),
    )
    expect(done).toMatchObject({ delivered: 1, pending: false })
  })
})

describe('the hourly sweep', () => {
  it('does the whole job with no queue at all, so a lost message costs an hour', async () => {
    // No sender installed: every emit is a no-op.
    await seedAlert('critical', { created_at: at(-600) })
    const { posts, publisher } = socialPublisher()
    const result = await sweepEvents(deps({ social: socialDeps(publisher) }))
    expect(result.fanOut.social).toBe(1)
    expect(result.social).toEqual({ sent: 1, pending: false })
    expect(posts).toHaveLength(1)
  })

  it('is idempotent: a second sweep sends nothing new', async () => {
    await seedAlert('critical', { created_at: at(-600) })
    const { posts, publisher } = socialPublisher()
    const d = deps({ social: socialDeps(publisher) })
    await sweepEvents(d)
    await sweepEvents(d)
    expect(posts).toHaveLength(1)
  })
})

describe('handleEventBatch', () => {
  function message(body: unknown, id = 'm1') {
    const calls: string[] = []
    const m: QueueMessageLike = {
      id,
      body,
      attempts: 1,
      ack: () => void calls.push('ack'),
      retry: () => void calls.push('retry'),
    }
    return { m, calls }
  }
  const body = (type: EventMessage['type']): EventMessage => ({ v: 1, type, sentAt: 0 })

  it('logs and skips a batch from another queue without touching its messages', async () => {
    const { m, calls } = message(body('alerts.new'))
    let built = 0
    const outcome = await handleEventBatch(
      { queue: 'other', messages: [m] },
      'frontier-terminal-events',
      () => {
        built++
        return deps()
      },
    )
    expect(outcome).toBe('unexpected-queue')
    expect(calls).toEqual([])
    expect(built).toBe(0)
  })

  it('acks an unreadable message instead of retrying it forever', async () => {
    const { m, calls } = message({ v: 2, type: 'alerts.new' })
    await handleEventBatch({ queue: 'q', messages: [m] }, 'q', () => deps())
    expect(calls).toEqual(['ack'])
  })

  it('runs each type once per batch and acks every message of it', async () => {
    queueFake()
    await seedAlert('critical', { created_at: at(-600) })
    const { posts, publisher } = socialPublisher()
    const a = message(body('social.drain'), 'a')
    const b = message(body('social.drain'), 'b')
    const d = deps({ social: socialDeps(publisher) })
    await fanOutAlerts(d)
    await handleEventBatch({ queue: 'q', messages: [a.m, b.m] }, 'q', () => d)
    expect(posts).toHaveLength(1)
    expect([...a.calls, ...b.calls]).toEqual(['ack', 'ack'])
  })

  it('retries the messages of a step that throws', async () => {
    const { m, calls } = message(body('social.drain'))
    const broken = deps({
      social: socialDeps(async () => {
        throw new Error('buffer down')
      }),
    })
    await seedAlert('critical', { created_at: at(-600) })
    await fanOutAlerts(broken)
    await handleEventBatch({ queue: 'q', messages: [m] }, 'q', () => broken)
    expect(calls).toEqual(['retry'])
  })
})
