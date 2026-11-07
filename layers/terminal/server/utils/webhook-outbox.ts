// The webhook outbox: one delivery per (alert, webhook), queued and sent by
// the EVENTS queue's fan-out and drain messages (layers/terminal/server/utils/event-work.ts),
// with the hourly events:sweep as backstop. "A run" below is any of those.
//
// Two promises shape it:
//   - A licensee never gets an alert before the public site shows it. A
//     delivery waits until the poll stamp, which keys every cached page and
//     payload (terminal-cache.ts, html-cache.ts), is later than the moment
//     the alert was written (alerts.recorded_at). Anything rendered under that
//     stamp was rendered after the alert was stored, so it lists it.
//   - A judged alert waits out the same one-hour hold as its social post
//     (layers/terminal/server/pipeline/social.ts › heldUntil), from the same instant: when
//     the alert was written. Suppressing
//     the post inside the hold suppresses the webhook too; so does deleting
//     the alert row. Deterministic alerts don't wait.
//
// Delivery is at least once: a send whose outcome is lost (a timeout, a
// killed invocation) is retried with the same X-Frontier-Delivery id, and the
// receiver dedupes on it. Takes the Drizzle client explicitly so
// layers/terminal/test/webhooks.test.ts drives it against workerd's D1.

import { and, asc, eq, inArray, lt, lte, ne, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'

import {
  buildWebhookPayload,
  WEBHOOK_SEVERITIES,
  type WebhookChangeRow,
} from '../../shared/utils/webhooks'
import { JUDGED_HOLD_MS } from '../pipeline/social'
import { D1_MAX_BOUND_PARAMS, type PipelineDb } from '../pipeline/store'
import { keyRefusal } from './api-key-token'
import { EXPORT_TABLES } from './terminal-export'
import { webhookUrlRefusal } from './webhook-url'
import {
  deriveWebhookSecret,
  nextWebhookAttemptAt,
  WEBHOOK_RETRY_WINDOW_MS,
  signedWebhookRequest,
  signingKeyId,
  type WebhookSender,
} from './webhook-sign'

const DAY_MS = 86_400_000

/**
 * Alerts written further back than this are not offered. Every alert write
 * emits a fan-out and the hourly sweep backs it up, so this only bites after
 * an outage longer than the lookback.
 */
export const WEBHOOK_ALERT_LOOKBACK_MS = 2 * DAY_MS

/** Deliveries one drain sends, CONCURRENCY at a time. */
export const WEBHOOK_DELIVERY_LIMIT = 20
const CONCURRENCY = 5

/** A claimed send is retried after this if its invocation dies mid-request. */
const CLAIM_LEASE_MS = 15 * 60_000

/** Finished deliveries are kept this long, well past the lookback, so none is offered twice. */
const RETENTION_MS = 30 * DAY_MS

const LIVE_WEBHOOK_STATUSES = ['active', 'failing']

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export interface WebhookEnqueueResult {
  queued: number
}

const iso = (julianDay: ReturnType<typeof sql>) => sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${julianDay})`

/** A severity's rank in WEBHOOK_SEVERITIES, NULL for one it doesn't list (severityReaches). */
const severityRank = (column: unknown) =>
  sql`CASE ${column} ${sql.join(
    WEBHOOK_SEVERITIES.map((s, i) => sql`WHEN ${s} THEN ${i}`),
    sql` `,
  )} END`

/** A v4 UUID, as crypto.randomUUID() writes it: the X-Frontier-Delivery id shape. */
const uuid = sql`lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) ||
  substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))`

/**
 * Queue a delivery for every alert written since a live webhook was added,
 * to each webhook whose severity it reaches, in one statement. Idempotent on
 * the unique (alert, webhook) index. A delivery is not due before the run
 * that queued it, nor before a judged alert's hold ends (heldUntil, in SQL).
 */
export async function enqueueWebhookDeliveries(
  db: PipelineDb,
  now: Date = new Date(),
): Promise<WebhookEnqueueResult> {
  const nowIso = now.toISOString()
  const since = new Date(now.getTime() - WEBHOOK_ALERT_LOOKBACK_MS).toISOString()
  const a = tables.alerts
  const h = tables.webhooks
  const k = tables.apiKeys
  const notBefore = iso(
    sql`max(julianday(${nowIso}), CASE WHEN ${a.rule} = 'agent-judge'
      THEN max(julianday(${a.created_at}), julianday(${a.recorded_at})) + ${JUDGED_HOLD_MS / DAY_MS}
      ELSE julianday(${a.created_at}) END)`,
  )
  const inserted = await db.all<{ id: string }>(sql`
    INSERT INTO ${tables.webhookDeliveries}
      (id, webhook_id, alert_id, status, seen_at, not_before, next_attempt_at)
    SELECT 'whd_' || ${uuid}, webhook_id, alert_id, 'queued', seen_at, not_before, not_before
    FROM (
      SELECT ${h.id} AS webhook_id, ${a.id} AS alert_id, ${a.recorded_at} AS seen_at,
        ${notBefore} AS not_before
      FROM ${a}
      JOIN ${h} ON ${a.recorded_at} >= ${h.created_at}
      JOIN ${k} ON ${k.id} = ${h.api_key_id}
      WHERE ${a.recorded_at} >= ${since}
        AND ${inArray(h.status, LIVE_WEBHOOK_STATUSES)}
        AND ${h.created_at} <= ${nowIso}
        AND ${k.revoked} = 0
        AND julianday(${k.expires_at}) > julianday(${nowIso})
        AND ${severityRank(a.severity)} >= ${severityRank(h.min_severity)}
    ) WHERE true
    ON CONFLICT (alert_id, webhook_id) DO NOTHING
    RETURNING id`)
  await prune(db, now)
  return { queued: inserted.length }
}

async function prune(db: PipelineDb, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString()
  await db
    .delete(tables.webhookDeliveries)
    .where(
      and(
        ne(tables.webhookDeliveries.status, 'queued'),
        lt(tables.webhookDeliveries.next_attempt_at, cutoff),
      ),
    )
}

export interface FailingWebhook {
  webhookId: string
  client: string
  error: string
}

export interface WebhookDrainResult {
  delivered: number
  retried: number
  failed: number
  expired: number
  cancelled: number
  suppressed: number
  /** Webhooks this drain marked failing; each has spooled one ops event. */
  failing: FailingWebhook[]
}

export interface WebhookDrainOptions {
  signingKey: string
  origin: string
  schemaVersion: string
  /** The live poll stamp (terminal-cache.ts › terminalStamps); null sends nothing. */
  stamp: string | null
  send: WebhookSender
  now?: Date
  limit?: number
}

type DueRow = Awaited<ReturnType<typeof dueDeliveries>>[number]

async function dueDeliveries(db: PipelineDb, nowIso: string, stamp: string, limit: number) {
  return db
    .select({
      id: tables.webhookDeliveries.id,
      alert_id: tables.webhookDeliveries.alert_id,
      not_before: tables.webhookDeliveries.not_before,
      attempts: tables.webhookDeliveries.attempts,
      webhook_id: tables.webhooks.id,
      url: tables.webhooks.url,
      signing_key_id: tables.webhooks.signing_key_id,
      client: tables.apiKeys.client,
      revoked: tables.apiKeys.revoked,
      expires_at: tables.apiKeys.expires_at,
    })
    .from(tables.webhookDeliveries)
    .innerJoin(tables.webhooks, eq(tables.webhooks.id, tables.webhookDeliveries.webhook_id))
    .innerJoin(tables.apiKeys, eq(tables.apiKeys.id, tables.webhooks.api_key_id))
    .where(
      and(
        eq(tables.webhookDeliveries.status, 'queued'),
        lte(tables.webhookDeliveries.next_attempt_at, nowIso),
        // Not before the public site: see the header.
        lt(tables.webhookDeliveries.seen_at, stamp),
        // A failing webhook's rows wait until webhooks:test brings it back.
        eq(tables.webhooks.status, 'active'),
      ),
    )
    .orderBy(asc(tables.webhookDeliveries.next_attempt_at))
    .limit(limit)
}

/** Send the deliveries that are due, oldest first. */
export async function drainWebhookDeliveries(
  db: PipelineDb,
  options: WebhookDrainOptions,
): Promise<WebhookDrainResult> {
  const now = options.now ?? new Date()
  const nowIso = now.toISOString()
  const result: WebhookDrainResult = {
    delivered: 0,
    retried: 0,
    failed: 0,
    expired: 0,
    cancelled: 0,
    suppressed: 0,
    failing: [],
  }
  if (!options.stamp) return result

  const due = await dueDeliveries(
    db,
    nowIso,
    options.stamp,
    options.limit ?? WEBHOOK_DELIVERY_LIMIT,
  )
  if (!due.length) return result

  const finish = (id: string, status: string, error: string | null = null) =>
    db
      .update(tables.webhookDeliveries)
      .set({ status, last_error: error })
      .where(
        and(eq(tables.webhookDeliveries.id, id), eq(tables.webhookDeliveries.status, 'queued')),
      )

  const alertIds = [...new Set(due.map((r) => r.alert_id))]
  const alerts = new Map(
    (await db.select().from(tables.alerts).where(inArray(tables.alerts.id, alertIds))).map((a) => [
      a.id,
      a,
    ]),
  )
  const suppressedPosts = new Set(
    (
      await db
        .select({ ref: tables.socialPosts.ref })
        .from(tables.socialPosts)
        .where(
          and(
            eq(tables.socialPosts.kind, 'alert'),
            eq(tables.socialPosts.status, 'suppressed'),
            inArray(tables.socialPosts.ref, alertIds),
          ),
        )
    ).map((r) => r.ref),
  )
  const keyId = await signingKeyId(options.signingKey)
  const brokenHooks = new Set<string>()

  const sendable: DueRow[] = []
  for (const row of due) {
    if (keyRefusal(row, now)) {
      await finish(row.id, 'cancelled', 'api key revoked or expired')
      result.cancelled++
    } else if (!alerts.has(row.alert_id) || suppressedPosts.has(row.alert_id)) {
      await finish(row.id, 'suppressed', 'alert withdrawn before delivery')
      result.suppressed++
    } else if (
      row.attempts === 0 &&
      now.getTime() > Date.parse(row.not_before) + WEBHOOK_RETRY_WINDOW_MS
    ) {
      // Never tried: it waited out the window while its webhook was paused
      // or the signing key was unset. Too stale to push now. A row that has
      // been tried goes on to its last attempt, which is what marks failing.
      await finish(row.id, 'expired', 'not sent within the retry window')
      result.expired++
    } else if (brokenHooks.has(row.webhook_id)) {
      continue
    } else {
      const problem =
        row.signing_key_id !== keyId
          ? 'NUXT_WEBHOOK_SIGNING_KEY changed since this webhook was added; remove and re-add it'
          : webhookUrlRefusal(row.url)
      if (problem) {
        brokenHooks.add(row.webhook_id)
        await markFailing(db, row, problem, now, result)
      } else {
        sendable.push(row)
      }
    }
  }

  const changes = await citedChanges(
    db,
    sendable.map((r) => alerts.get(r.alert_id)!),
  )

  for (const batch of chunks(sendable, CONCURRENCY)) {
    await Promise.all(
      batch.map((row) =>
        deliver(db, row, alerts.get(row.alert_id)!, changes, options, now, result),
      ),
    )
  }
  return result
}

async function citedChanges(
  db: PipelineDb,
  alerts: readonly (typeof tables.alerts.$inferSelect)[],
): Promise<Map<string, WebhookChangeRow>> {
  const ids = new Set<string>()
  for (const alert of alerts) for (const id of changeIdsOf(alert.change_ids)) ids.add(id)
  // A cited change carries the columns of the changes export, in its order.
  const { columns } = EXPORT_TABLES.changes!
  const out = new Map<string, WebhookChangeRow>()
  for (const batch of chunks([...ids], D1_MAX_BOUND_PARAMS - 1)) {
    const rows = await db.select().from(tables.changes).where(inArray(tables.changes.id, batch))
    for (const row of rows) {
      const record: Record<string, unknown> = row
      out.set(row.id, {
        ...Object.fromEntries(columns.map((c) => [c, record[c] ?? null])),
        source_url: row.source_url,
      })
    }
  }
  return out
}

function changeIdsOf(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

async function deliver(
  db: PipelineDb,
  row: DueRow,
  alert: typeof tables.alerts.$inferSelect,
  changes: Map<string, WebhookChangeRow>,
  options: WebhookDrainOptions,
  now: Date,
  result: WebhookDrainResult,
): Promise<void> {
  // Claim it. The attempts guard makes an overlapping drain skip the row, and
  // the lease brings it back if this invocation dies mid-send.
  const attempt = row.attempts + 1
  const claimed = await db
    .update(tables.webhookDeliveries)
    .set({
      attempts: attempt,
      last_attempt_at: now.toISOString(),
      next_attempt_at: new Date(now.getTime() + CLAIM_LEASE_MS).toISOString(),
    })
    .where(
      and(
        eq(tables.webhookDeliveries.id, row.id),
        eq(tables.webhookDeliveries.status, 'queued'),
        eq(tables.webhookDeliveries.attempts, row.attempts),
      ),
    )
    .returning({ id: tables.webhookDeliveries.id })
  if (!claimed.length) return

  const payload = buildWebhookPayload({
    schemaVersion: options.schemaVersion,
    event: 'alert.created',
    deliveryId: row.id,
    sentAt: now,
    origin: options.origin,
    alert,
    changes: changeIdsOf(alert.change_ids)
      .map((id) => changes.get(id))
      .filter((c) => c !== undefined),
  })
  const secret = await deriveWebhookSecret(options.signingKey, row.webhook_id)
  const outcome = await options.send(await signedWebhookRequest(row.url, secret, payload))

  if (outcome.ok) {
    await db
      .update(tables.webhookDeliveries)
      .set({
        status: 'delivered',
        delivered_at: now.toISOString(),
        last_status: outcome.status,
        last_error: null,
      })
      .where(eq(tables.webhookDeliveries.id, row.id))
    result.delivered++
    return
  }

  const next = nextWebhookAttemptAt(new Date(row.not_before), attempt, now)
  await db
    .update(tables.webhookDeliveries)
    .set({
      status: next ? 'queued' : 'failed',
      next_attempt_at: (next ?? now).toISOString(),
      last_status: outcome.status,
      last_error: outcome.error,
    })
    .where(eq(tables.webhookDeliveries.id, row.id))
  if (next) {
    result.retried++
  } else {
    result.failed++
    await markFailing(
      db,
      row,
      `${outcome.error} on attempt ${attempt}; gave up after 24 hours of retries`,
      now,
      result,
    )
  }
}

/**
 * Mark a webhook failing and spool one ops event, only on the transition
 * from active: a webhook that fails ten deliveries wakes the owner once.
 */
async function markFailing(
  db: PipelineDb,
  row: Pick<DueRow, 'webhook_id' | 'client' | 'url'>,
  error: string,
  now: Date,
  result: WebhookDrainResult,
): Promise<void> {
  const flipped = await db
    .update(tables.webhooks)
    .set({ status: 'failing', failing_since: now.toISOString(), last_error: error.slice(0, 500) })
    .where(and(eq(tables.webhooks.id, row.webhook_id), eq(tables.webhooks.status, 'active')))
    .returning({ id: tables.webhooks.id })
  if (!flipped.length) return
  result.failing.push({ webhookId: row.webhook_id, client: row.client, error })
  await recordOpsEvent(db, {
    kind: 'webhook_failing',
    detail: `${row.webhook_id} (${row.client}, ${hostOf(row.url)}): ${error}. Deliveries are paused; bun run webhooks:test -- --id ${row.webhook_id} --remote resumes them once it answers.`,
  })
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid url'
  }
}
