// Alert webhooks: the signature, the URL guard, the retry schedule, severity
// filtering, and the outbox against a real D1 (idempotent enqueue, the public
// and judged-hold gates, retries, the one ops event when a webhook fails).

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { PAID_LICENSE } from '~~/shared/utils/license'
import { JUDGED_HOLD_MS } from '../server/pipeline/social'
import { expiryAfter } from '../server/utils/api-key-token'
import {
  WEBHOOK_BASELINE_MARKER,
  drainWebhookDeliveries,
  enqueueWebhookDeliveries,
  type WebhookDrainOptions,
} from '../server/utils/webhook-outbox'
import {
  deriveWebhookSecret,
  fetchWebhookSender,
  generateWebhookId,
  nextWebhookAttemptAt,
  webhookRetryDelayMs,
  WEBHOOK_RETRY_WINDOW_MS,
  signedWebhookRequest,
  signingKeyId,
  signingKeyRefusal,
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_ID_SHAPE,
  type WebhookRequest,
} from '../server/utils/webhook-sign'
import { addressRefusal, isPrivateAddress, webhookUrlRefusal } from '../server/utils/webhook-url'
import {
  exampleWebhookPayload,
  severityReaches,
  WEBHOOK_HEADERS,
  type WebhookPayload,
} from '../shared/utils/webhooks'

const db = drizzle(env.DB, { schema })

const KEY = 'k'.repeat(40)
const ORIGIN = 'https://frontierterm.com'
const T0 = new Date('2026-11-04T12:00:00.000Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
const MIN = 60_000

// ── Signing ─────────────────────────────────────────────────────────────────

async function referenceHmac(key: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('signing', () => {
  it('signs the raw body with HMAC-SHA256 of the secret, as sha256=<hex>', async () => {
    const body = '{"a":1}'
    expect(await signWebhookBody('whsec_x', body)).toBe(
      `sha256=${await referenceHmac('whsec_x', body)}`,
    )
    // RFC 4231 test case 2.
    expect(await signWebhookBody('Jefe', 'what do ya want for nothing?')).toBe(
      'sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
  })

  it('verifies its own signature and rejects a changed body or secret', async () => {
    const sig = await signWebhookBody('whsec_a', 'body')
    expect(await verifyWebhookSignature('whsec_a', 'body', sig)).toBe(true)
    expect(await verifyWebhookSignature('whsec_a', 'body ', sig)).toBe(false)
    expect(await verifyWebhookSignature('whsec_b', 'body', sig)).toBe(false)
    expect(await verifyWebhookSignature('whsec_a', 'body', 'sha256=00')).toBe(false)
  })

  it('derives a stable secret per webhook and per signing key', async () => {
    const a = await deriveWebhookSecret(KEY, 'whk_0000000001')
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
    expect(await deriveWebhookSecret(KEY, 'whk_0000000001')).toBe(a)
    expect(await deriveWebhookSecret(KEY, 'whk_0000000002')).not.toBe(a)
    expect(await deriveWebhookSecret('j'.repeat(40), 'whk_0000000001')).not.toBe(a)
    expect(await signingKeyId(KEY)).toMatch(/^[0-9a-f]{12}$/)
    expect(await signingKeyId(KEY)).not.toBe(await signingKeyId('j'.repeat(40)))
  })

  it('refuses a missing or short signing key', () => {
    expect(signingKeyRefusal('')).toMatch(/not set/)
    expect(signingKeyRefusal('short')).toMatch(/at least 32/)
    expect(signingKeyRefusal(KEY)).toBeNull()
  })

  it('makes webhook ids of one shape', () => {
    expect(generateWebhookId()).toMatch(WEBHOOK_ID_SHAPE)
  })

  it('puts the delivery id and the signed sent_at in the headers', async () => {
    const payload = exampleWebhookPayload({
      schemaVersion: '9.9.9',
      origin: ORIGIN,
      deliveryId: 'whd_1',
      sentAt: new Date('2026-11-04T12:00:05.500Z'),
    })
    const req = await signedWebhookRequest('https://hooks.example.org/x', 'whsec_s', payload)
    expect(req.headers[WEBHOOK_HEADERS.delivery]).toBe('whd_1')
    expect(req.headers[WEBHOOK_HEADERS.timestamp]).toBe('1793793605')
    expect(req.headers[WEBHOOK_HEADERS.event]).toBe('alert.created')
    expect(req.headers[WEBHOOK_HEADERS.signature]).toBe(await signWebhookBody('whsec_s', req.body))
    expect(JSON.parse(req.body)).toEqual(payload)
  })

  it('counts only a 2xx as delivered and never follows a redirect', async () => {
    const seen: RequestInit[] = []
    const reply = (status: number) =>
      fetchWebhookSender(async (_url, init) => {
        seen.push(init!)
        return new Response(null, { status, headers: { location: 'https://x.example.org' } })
      })
    const request: WebhookRequest = { url: 'https://h.example.org', headers: {}, body: '{}' }
    expect(await reply(204)(request)).toEqual({ ok: true, status: 204 })
    expect(await reply(302)(request)).toMatchObject({ ok: false, error: /redirects/ })
    expect(await reply(500)(request)).toMatchObject({ ok: false, status: 500 })
    expect(seen[0]!.redirect).toBe('manual')
    const thrown = fetchWebhookSender(async () => {
      throw new Error('boom')
    })
    expect(await thrown(request)).toMatchObject({ ok: false, status: null, error: /boom/ })
  })
})

// ── SSRF guard ──────────────────────────────────────────────────────────────

describe('webhook URLs', () => {
  it('allows a public https name', () => {
    expect(webhookUrlRefusal('https://hooks.acme-capital.com/frontier')).toBeNull()
    expect(webhookUrlRefusal('https://hooks.acme-capital.com:443/x?y=1')).toBeNull()
  })

  it.each([
    ['http://hooks.acme.com/x', /https/],
    ['ftp://hooks.acme.com/x', /https/],
    ['https://user:pw@hooks.acme.com/x', /credentials/],
    ['https://hooks.acme.com:8443/x', /port/],
    ['https://hooks.acme.com/x#frag', /fragment/],
    ['https://127.0.0.1/x', /IP address/],
    ['https://10.0.0.1/x', /IP address/],
    ['https://2130706433/x', /IP address/],
    ['https://0x7f.1/x', /IP address/],
    ['https://[::1]/x', /IP address/],
    ['https://[fd00::1]/x', /IP address/],
    ['https://localhost/x', /fully qualified/],
    ['https://api.localhost/x', /localhost/],
    ['https://printer.local/x', /\.local/],
    ['https://metadata.google.internal/x', /\.internal/],
    ['https://router.home.arpa/x', /arpa/],
    ['https://intranet/x', /fully qualified/],
    ['not a url', /Not a URL/],
    [`https://a.com/${'x'.repeat(2100)}`, /longer/],
  ])('refuses %s', (url, why) => {
    expect(webhookUrlRefusal(url)).toMatch(why)
  })

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.10',
    '::1',
    '::',
    'fd12:3456::1',
    'fe80::1%en0',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2001:db8::1',
    'ff02::1',
    'garbage',
  ])('treats %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  it.each(['93.184.216.34', '172.32.0.1', '8.8.8.8', '2606:4700::6810:85e5', '::ffff:8.8.8.8'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false)
    },
  )

  it('refuses a name that resolves anywhere private, or nowhere', () => {
    expect(addressRefusal(['8.8.8.8'])).toBeNull()
    expect(addressRefusal(['8.8.8.8', '10.0.0.1'])).toMatch(/10\.0\.0\.1/)
    expect(addressRefusal([])).toMatch(/does not resolve/)
  })
})

// ── Retry schedule and severity ─────────────────────────────────────────────

describe('retries', () => {
  it('backs off from 5 minutes, doubling, capped at 6 hours', () => {
    expect(webhookRetryDelayMs(1)).toBe(5 * MIN)
    expect(webhookRetryDelayMs(2)).toBe(10 * MIN)
    expect(webhookRetryDelayMs(3)).toBe(20 * MIN)
    expect(webhookRetryDelayMs(8)).toBe(360 * MIN)
    expect(webhookRetryDelayMs(20)).toBe(360 * MIN)
  })

  it('gives up when the next attempt would fall past 24 hours from due', () => {
    let now = T0
    let attempts = 0
    for (;;) {
      attempts++
      const next = nextWebhookAttemptAt(T0, attempts, now)
      if (!next) break
      now = next
    }
    expect(now.getTime() - T0.getTime()).toBeLessThanOrEqual(WEBHOOK_RETRY_WINDOW_MS)
    expect(attempts).toBe(10)
  })
})

describe('severity filter', () => {
  it('sends an alert at or above the webhook severity', () => {
    expect(severityReaches('critical', 'notable')).toBe(true)
    expect(severityReaches('notable', 'notable')).toBe(true)
    expect(severityReaches('info', 'notable')).toBe(false)
    expect(severityReaches('info', 'info')).toBe(true)
    expect(severityReaches('notable', 'critical')).toBe(false)
    expect(severityReaches('bogus', 'info')).toBe(false)
  })
})

// ── The outbox ──────────────────────────────────────────────────────────────

const KEY_ID = 'key_00000000aa'

async function seedKey(overrides: Partial<schema.ApiKeyRow> = {}) {
  await db.insert(schema.apiKeys).values({
    id: KEY_ID,
    key_hash: 'h'.repeat(64),
    client: 'Acme Capital',
    tier: 'research',
    issued_at: T0.toISOString(),
    expires_at: expiryAfter(T0, 12),
    revoked: false,
    revoked_at: null,
    ...overrides,
  })
}

async function seedWebhook(id: string, min_severity: string, created_at = at(-60)) {
  await db.insert(schema.webhooks).values({
    id,
    api_key_id: KEY_ID,
    url: `https://hooks.acme.example.org/${id}`,
    min_severity,
    secret_hash: 'x',
    signing_key_id: await signingKeyId(KEY),
    status: 'active',
    created_at: created_at.toISOString(),
  })
}

let alertN = 0
async function seedAlert(severity: string, opts: { rule?: string; created_at?: Date } = {}) {
  const id = (++alertN).toString(16).padStart(64, '0')
  const created_at = (opts.created_at ?? at(-5)).toISOString()
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
  })
  return id
}

/** The first run only records a baseline; tests start after it. */
async function baseline(now = at(-30)) {
  return enqueueWebhookDeliveries(db, now)
}

function recorder(status = 200) {
  const sent: WebhookRequest[] = []
  const send = async (request: WebhookRequest) => {
    sent.push(request)
    return status >= 200 && status < 300
      ? { ok: true as const, status }
      : { ok: false as const, status, error: `HTTP ${status}` }
  }
  return { sent, send }
}

function drainAt(
  now: Date,
  send: WebhookDrainOptions['send'],
  stamp: string | null = now.toISOString(),
) {
  return drainWebhookDeliveries(db, {
    signingKey: KEY,
    origin: ORIGIN,
    schemaVersion: '1.1.0',
    stamp,
    send,
    now,
  })
}

const deliveries = () => db.select().from(schema.webhookDeliveries)

beforeEach(async () => {
  for (const table of [
    schema.webhookDeliveries,
    schema.webhookAlertLog,
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

describe('enqueue', () => {
  it('records a baseline on its first run and queues nothing from before it', async () => {
    await seedKey()
    await seedWebhook('whk_000000000a', 'info')
    await seedAlert('critical', { created_at: at(-120) })
    const first = await baseline()
    expect(first).toMatchObject({ baseline: true, queued: 0, seen: 1 })
    const [marker] = await db
      .select()
      .from(schema.webhookAlertLog)
      .where(eq(schema.webhookAlertLog.alert_id, WEBHOOK_BASELINE_MARKER))
    expect(marker).toBeDefined()
    expect(await enqueueWebhookDeliveries(db, T0)).toMatchObject({ baseline: false, queued: 0 })
  })

  it('queues one delivery per webhook whose severity the alert reaches', async () => {
    await seedKey()
    await seedWebhook('whk_000000000a', 'info')
    await seedWebhook('whk_000000000b', 'notable')
    await seedWebhook('whk_000000000c', 'critical')
    await baseline()
    const info = await seedAlert('info')
    const notable = await seedAlert('notable')
    const critical = await seedAlert('critical')

    expect(await enqueueWebhookDeliveries(db, T0)).toMatchObject({ seen: 3, queued: 6 })
    const rows = await deliveries()
    const to = (alert: string) =>
      rows
        .filter((r) => r.alert_id === alert)
        .map((r) => r.webhook_id)
        .sort()
    expect(to(info)).toEqual(['whk_000000000a'])
    expect(to(notable)).toEqual(['whk_000000000a', 'whk_000000000b'])
    expect(to(critical)).toEqual(['whk_000000000a', 'whk_000000000b', 'whk_000000000c'])
    expect(new Set(rows.map((r) => r.id)).size).toBe(6)
  })

  it('is idempotent on alert and webhook', async () => {
    await seedKey()
    await seedWebhook('whk_000000000a', 'info')
    await baseline()
    const id = await seedAlert('critical')
    expect((await enqueueWebhookDeliveries(db, T0)).queued).toBe(1)
    expect((await enqueueWebhookDeliveries(db, at(5))).queued).toBe(0)

    // Even with the log row gone, the unique (alert, webhook) index holds.
    await db.delete(schema.webhookAlertLog).where(eq(schema.webhookAlertLog.alert_id, id))
    expect((await enqueueWebhookDeliveries(db, at(10))).queued).toBe(0)
    await db
      .insert(schema.webhookDeliveries)
      .values({
        id: 'whd_dup',
        webhook_id: 'whk_000000000a',
        alert_id: id,
        seen_at: T0.toISOString(),
        not_before: T0.toISOString(),
        next_attempt_at: T0.toISOString(),
      })
      .onConflictDoNothing()
    expect(await deliveries()).toHaveLength(1)
  })

  it('sends a new webhook only alerts first seen after it was added', async () => {
    await seedKey()
    await baseline()
    await seedAlert('critical')
    await enqueueWebhookDeliveries(db, T0)
    await seedWebhook('whk_000000000a', 'info', at(1))
    await enqueueWebhookDeliveries(db, at(5))
    expect(await deliveries()).toHaveLength(0)
    await seedAlert('critical', { created_at: at(6) })
    expect((await enqueueWebhookDeliveries(db, at(10))).queued).toBe(1)
  })

  it('skips webhooks whose key is revoked or expired, and removed webhooks', async () => {
    await seedKey({ revoked: true, revoked_at: T0.toISOString() })
    await seedWebhook('whk_000000000a', 'info')
    await baseline()
    await seedAlert('critical')
    expect((await enqueueWebhookDeliveries(db, T0)).queued).toBe(0)

    await db.update(schema.apiKeys).set({ revoked: false, expires_at: at(-1).toISOString() })
    await seedAlert('critical')
    expect((await enqueueWebhookDeliveries(db, at(1))).queued).toBe(0)

    await db.update(schema.apiKeys).set({ expires_at: expiryAfter(T0, 12) })
    await db.update(schema.webhooks).set({ status: 'removed' })
    await seedAlert('critical')
    expect((await enqueueWebhookDeliveries(db, at(2))).queued).toBe(0)
  })

  it('holds a judged alert for the social layer’s hour, from the same instant', async () => {
    await seedKey()
    await seedWebhook('whk_000000000a', 'info')
    await baseline()
    await seedAlert('critical', { rule: 'agent-judge', created_at: at(-10) })
    await seedAlert('critical', { rule: 'rule-x', created_at: at(-10) })
    await enqueueWebhookDeliveries(db, T0)
    const rows = await deliveries()
    const judged = rows.find((r) => r.not_before !== T0.toISOString())!
    expect(Date.parse(judged.not_before)).toBe(at(-10).getTime() + JUDGED_HOLD_MS)
    expect(rows.filter((r) => r.not_before === T0.toISOString())).toHaveLength(1)
  })
})

describe('drain', () => {
  async function oneQueued(severity = 'critical', rule = 'rule-x') {
    await seedKey()
    await seedWebhook('whk_000000000a', 'info')
    await baseline()
    const id = await seedAlert(severity, { rule })
    await enqueueWebhookDeliveries(db, T0)
    return id
  }

  it('sends a signed payload with the alert, its changes, permalink and paid license', async () => {
    const alertId = await oneQueued()
    const { sent, send } = recorder()
    const result = await drainAt(at(5), send)
    expect(result).toMatchObject({ delivered: 1, retried: 0, failed: 0 })
    expect(sent).toHaveLength(1)

    const [req] = sent
    const secret = await deriveWebhookSecret(KEY, 'whk_000000000a')
    expect(
      await verifyWebhookSignature(secret, req!.body, req!.headers[WEBHOOK_HEADERS.signature]!),
    ).toBe(true)
    const body = JSON.parse(req!.body) as WebhookPayload
    const [row] = await deliveries()
    expect(req!.headers[WEBHOOK_HEADERS.delivery]).toBe(row!.id)
    expect(body).toMatchObject({
      schema_version: '1.1.0',
      event: 'alert.created',
      delivery_id: row!.id,
      sent_at: at(5).toISOString(),
      alert: {
        id: alertId,
        severity: 'critical',
        permalink: `${ORIGIN}/alerts/${alertId}`,
        source_urls: ['https://openai.com/api/pricing'],
        change_count: 1,
      },
      license: { older: { id: PAID_LICENSE.id } },
    })
    expect(body.alert.changes[0]).toMatchObject({ after_json: '{"p":2}', entity_type: 'price' })
    expect(row).toMatchObject({ status: 'delivered', attempts: 1, last_status: 200 })

    expect((await drainAt(at(10), send)).delivered).toBe(0)
  })

  it('waits until the public site has moved past the moment the alert was seen', async () => {
    await oneQueued()
    const { sent, send } = recorder()
    await drainAt(at(5), send, null)
    await drainAt(at(5), send, T0.toISOString())
    await drainAt(at(5), send, at(-1).toISOString())
    expect(sent).toHaveLength(0)
    await drainAt(at(5), send, at(1).toISOString())
    expect(sent).toHaveLength(1)
  })

  it('holds a judged alert for an hour, and drops one suppressed in that hour', async () => {
    const alertId = await oneQueued('critical', 'agent-judge')
    const { sent, send } = recorder()
    await drainAt(at(30), send)
    expect(sent).toHaveLength(0)

    await db.insert(schema.socialPosts).values({
      service: 'x',
      kind: 'alert',
      ref: alertId,
      body: '{"posts":[]}',
      status: 'suppressed',
      notBefore: T0,
    })
    expect((await drainAt(at(61), send)).suppressed).toBe(1)
    expect(sent).toHaveLength(0)
    expect((await deliveries())[0]!.status).toBe('suppressed')
  })

  it('drops a delivery whose alert was deleted, and cancels one whose key was revoked', async () => {
    const alertId = await oneQueued()
    await db.delete(schema.alerts).where(eq(schema.alerts.id, alertId))
    const { send } = recorder()
    expect((await drainAt(at(5), send)).suppressed).toBe(1)

    await seedAlert('critical')
    await enqueueWebhookDeliveries(db, at(6))
    await db.update(schema.apiKeys).set({ revoked: true })
    expect((await drainAt(at(10), send)).cancelled).toBe(1)
  })

  it('retries with backoff, then marks the webhook failing with one ops event', async () => {
    await oneQueued()
    await seedAlert('critical')
    await enqueueWebhookDeliveries(db, at(1))
    const { send } = recorder(503)

    let now = at(5)
    const first = await drainAt(now, send)
    expect(first.retried).toBe(2)
    const [row] = await deliveries()
    expect(Date.parse(row!.next_attempt_at)).toBe(now.getTime() + 5 * MIN)
    expect(row).toMatchObject({ status: 'queued', attempts: 1, last_status: 503 })

    let failing = 0
    for (let i = 0; i < 20; i++) {
      const next = (await deliveries())
        .filter((r) => r.status === 'queued')
        .map((r) => Date.parse(r.next_attempt_at))
        .sort((a, b) => a - b)[0]
      if (next === undefined) break
      now = new Date(next)
      const result = await drainAt(now, send)
      failing += result.failing.length
    }
    expect(failing).toBe(1)
    const [hook] = await db.select().from(schema.webhooks)
    expect(hook).toMatchObject({ status: 'failing' })
    expect(hook!.last_error).toMatch(/HTTP 503/)
    const events = await db.select().from(schema.opsEvents)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'webhook_failing' })
    expect(events[0]!.detail).toContain('whk_000000000a')

    // Both deliveries ran out of retries; the owner heard about it once.
    const rows = await deliveries()
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed'])
    expect(rows.map((r) => r.attempts)).toEqual([10, 10])

    // A new alert waits, paused, until webhooks:test brings the webhook back.
    await seedAlert('critical', { created_at: now })
    await enqueueWebhookDeliveries(db, now)
    const later = new Date(now.getTime() + 10 * MIN)
    expect((await drainAt(later, send)).retried).toBe(0)
    expect((await deliveries()).filter((r) => r.status === 'queued')).toHaveLength(1)
  })

  it('expires a delivery never tried within 24 hours', async () => {
    await oneQueued()
    const { sent, send } = recorder()
    const result = await drainAt(new Date(T0.getTime() + WEBHOOK_RETRY_WINDOW_MS + 10 * MIN), send)
    expect(result.expired).toBe(1)
    expect(sent).toHaveLength(0)
  })

  it('fails loudly when the signing key changed since the webhook was added', async () => {
    await oneQueued()
    await db.update(schema.webhooks).set({ signing_key_id: '000000000000' })
    const { sent, send } = recorder()
    const result = await drainAt(at(5), send)
    expect(sent).toHaveLength(0)
    expect(result.failing[0]!.error).toMatch(/NUXT_WEBHOOK_SIGNING_KEY changed/)
    expect(await db.select().from(schema.opsEvents)).toHaveLength(1)
  })

  it('re-checks the URL before sending', async () => {
    await oneQueued()
    await db.update(schema.webhooks).set({ url: 'https://169.254.169.254/latest' })
    const { sent, send } = recorder()
    const result = await drainAt(at(5), send)
    expect(sent).toHaveLength(0)
    expect(result.failing[0]!.error).toMatch(/IP address/)
  })
})
