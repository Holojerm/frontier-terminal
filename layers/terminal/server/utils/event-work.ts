// What each EVENTS message does (layers/terminal/server/utils/events.ts says
// why the queue exists). Every dependency is passed in, so
// layers/terminal/test/events.test.ts drives the whole thing against workerd's D1
// with fakes for Buffer, the webhook sender, the mail binding and the queue.
//
// The outboxes are unchanged: these functions call the same idempotent
// enqueue and drain steps the */5 tasks used to, then decide when the next
// drain is owed.

import { and, asc, eq } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { OwnerMailer } from './owner-mail'
import { drainSocialPosts, type SocialConfig } from '#layers/social/server/utils/social'
import type { SocialPublisher } from '#layers/social/server/utils/buffer'

import { pendingPressAlerts, pressBrief, type PressContact } from '../pipeline/press'
import { enqueueCriticalAlerts } from '../pipeline/social'
import type { PipelineDb } from '../pipeline/store'
import { delaySecondsUntil, scheduleDrain } from './events'
import type { CacheStore } from './terminal-cache'
import {
  drainWebhookDeliveries,
  enqueueWebhookDeliveries,
  type WebhookDrainResult,
} from './webhook-outbox'
import type { WebhookSender } from './webhook-sign'

/**
 * The first drain after a fan-out waits this long. The alert row commits
 * before its source's source_runs row, and a webhook is not sent until the
 * poll stamp passes (webhook-outbox.ts); a minute lets the poll finish that
 * source, so the first drain usually finds the delivery ready.
 */
export const FANOUT_SETTLE_SECONDS = 60

/**
 * When a drain leaves due rows behind (Buffer's per-drain limit, a retried
 * post, a delivery waiting on the poll stamp), the next one runs this much
 * later. The same pace the five-minute tick kept, now only while work is owed.
 */
export const PENDING_RECHECK_SECONDS = 300

export interface SocialDeps {
  config: SocialConfig
  publisher: SocialPublisher
  origin: string
}

export interface WebhookDeps {
  signingKey: string
  origin: string
  schemaVersion: string
  stamp: () => Promise<string | null>
  send: WebhookSender
}

export interface PressDeps {
  contacts: readonly PressContact[]
  mailer: OwnerMailer
  origin: string
  /** The `press:briefed:<id>` markers: an alert is briefed once. */
  briefed: CacheStore
}

export interface EventDeps {
  db: PipelineDb
  /** Holds the scheduled-drain markers (events.ts › scheduleDrain). */
  store: CacheStore
  now: () => Date
  /** Each is null when that outbox is unconfigured; its steps are skipped. */
  social: SocialDeps | null
  webhooks: WebhookDeps | null
  press: PressDeps | null
  /** Spools an ops event; recordOpsEvent in production. */
  record: (kind: string, detail: string) => Promise<void>
}

export const briefedKey = (id: string) => `press:briefed:${id}`

/** Oldest queued post, or null when the social outbox is empty. */
export async function nextSocialDue(db: PipelineDb): Promise<Date | null> {
  const [row] = await db
    .select({ due: tables.socialPosts.notBefore })
    .from(tables.socialPosts)
    .where(eq(tables.socialPosts.status, 'queued'))
    .orderBy(asc(tables.socialPosts.notBefore))
    .limit(1)
  return row?.due ?? null
}

/**
 * Earliest queued delivery to an active webhook. A failing webhook's rows are
 * left out: they wait for webhooks:test, and counting them would keep a drain
 * chain alive forever.
 */
export async function nextWebhookDue(db: PipelineDb): Promise<Date | null> {
  const [row] = await db
    .select({ due: tables.webhookDeliveries.next_attempt_at })
    .from(tables.webhookDeliveries)
    .innerJoin(tables.webhooks, eq(tables.webhooks.id, tables.webhookDeliveries.webhook_id))
    .where(and(eq(tables.webhookDeliveries.status, 'queued'), eq(tables.webhooks.status, 'active')))
    .orderBy(asc(tables.webhookDeliveries.next_attempt_at))
    .limit(1)
  return row ? new Date(row.due) : null
}

export interface FanOutResult {
  social: number | null
  webhooks: number | null
  press: number | null
}

/**
 * New alerts are stored: offer them to every outbox, mail any press brief,
 * and schedule each outbox's first drain.
 */
export async function fanOutAlerts(deps: EventDeps): Promise<FanOutResult> {
  const now = deps.now()
  const result: FanOutResult = { social: null, webhooks: null, press: null }

  if (deps.social) {
    result.social = await enqueueCriticalAlerts(
      deps.db,
      deps.social.config.channels,
      deps.social.origin,
    )
    await scheduleNext(
      deps,
      'social.drain',
      await nextSocialDue(deps.db),
      now,
      FANOUT_SETTLE_SECONDS,
    )
  }
  if (deps.webhooks) {
    result.webhooks = (await enqueueWebhookDeliveries(deps.db, now)).queued
    await scheduleNext(
      deps,
      'webhooks.drain',
      await nextWebhookDue(deps.db),
      now,
      FANOUT_SETTLE_SECONDS,
    )
  }
  if (deps.press) result.press = await sendPressBriefs(deps, deps.press)
  return result
}

/** Mail the owner one brief per new registration-filing alert. Returns how many went out. */
async function sendPressBriefs(deps: EventDeps, press: PressDeps): Promise<number> {
  const pending = await pendingPressAlerts(deps.db, async (id) =>
    Boolean(await press.briefed.get(briefedKey(id))),
  )
  let sent = 0
  for (const alert of pending) {
    try {
      await press.mailer(pressBrief(alert, press.contacts, press.origin))
      await press.briefed.set(briefedKey(alert.id), deps.now().toISOString())
      sent++
    } catch (error) {
      await deps.record(
        'press_brief_failed',
        `${alert.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return sent
}

/** Send due posts, spool anything that needs a person, and schedule the next drain. */
export async function runSocialDrain(
  deps: EventDeps,
): Promise<{ sent: number; pending: boolean } | null> {
  if (!deps.social) return null
  const now = deps.now()
  const outcome = await drainSocialPosts(deps.db, {
    config: deps.social.config,
    publisher: deps.social.publisher,
    now,
  })
  // A failed or maybe-sent post needs a person, so it goes to the ops digest.
  // `unknown` is never retried: Buffer may already have posted it.
  for (const problem of outcome.problems) {
    await deps.record(
      `social_${problem.status}`,
      `${problem.service} ${problem.kind}/${problem.ref} (row ${problem.id}): ${problem.error}`,
    )
  }
  const next = await nextSocialDue(deps.db)
  await scheduleNext(deps, 'social.drain', next, now, PENDING_RECHECK_SECONDS)
  return { sent: outcome.sent, pending: next !== null }
}

/** Send due deliveries and schedule the next drain, which is how backoff retries happen. */
export async function runWebhookDrain(
  deps: EventDeps,
): Promise<(Omit<WebhookDrainResult, 'failing'> & { failing: number; pending: boolean }) | null> {
  if (!deps.webhooks) return null
  const now = deps.now()
  const { failing, ...counts } = await drainWebhookDeliveries(deps.db, {
    signingKey: deps.webhooks.signingKey,
    origin: deps.webhooks.origin,
    schemaVersion: deps.webhooks.schemaVersion,
    stamp: await deps.webhooks.stamp(),
    send: deps.webhooks.send,
    now,
  })
  const next = await nextWebhookDue(deps.db)
  await scheduleNext(deps, 'webhooks.drain', next, now, PENDING_RECHECK_SECONDS)
  return { ...counts, failing: failing.length, pending: next !== null }
}

/**
 * The hourly backstop (events:sweep): the same work every message type does,
 * in order, so a lost `alerts.new` or a broken drain chain costs at most an
 * hour. Overlapping the queue is harmless, as everything here is idempotent.
 */
export async function sweepEvents(deps: EventDeps) {
  const fanOut = await fanOutAlerts(deps)
  const social = await runSocialDrain(deps)
  const webhooks = await runWebhookDrain(deps)
  return { fanOut, social, webhooks }
}

async function scheduleNext(
  deps: EventDeps,
  type: 'social.drain' | 'webhooks.drain',
  due: Date | null,
  now: Date,
  floorSeconds: number,
): Promise<void> {
  const delay = delaySecondsUntil(due, now, floorSeconds)
  if (delay !== null) await scheduleDrain(deps.store, type, delay, now)
}
