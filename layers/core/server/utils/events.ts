// The EVENTS queue drives alert delivery. Alert writers emit `alerts.new`; the
// consumer (layers/alerts/server/plugins/events-queue.ts) fans out to the social
// and webhook outboxes and the press briefs, then schedules a delayed drain per
// outbox at its earliest due row, so a quiet day costs no D1 reads. The queue
// carries triggers, never state: the outbox tables and press KV markers are the
// record and every handler is idempotent, so a duplicate is harmless and a lost
// message is caught by the hourly events:sweep. The sender is module-level and
// null by default, so pipeline code and tests need no Worker env.

import { z } from 'zod'

import { logEvent } from '#server/utils/log'

import type { CacheStore } from './terminal-cache'

/** Binding name; must match `binding` in `[[queues.producers]]` in wrangler.toml. */
export const EVENTS_QUEUE_BINDING = 'EVENTS'

/** Queues refuses a longer delay. */
export const MAX_DELAY_SECONDS = 86_400

export const EVENT_TYPES = ['alerts.new', 'social.drain', 'webhooks.drain'] as const
export type EventType = (typeof EVENT_TYPES)[number]

/**
 * `v` is a schema version: the queue holds messages the previous deploy wrote,
 * and a consumer that parses them against a changed shape must ack, not loop.
 */
export const EventMessageSchema = z.object({
  v: z.literal(1),
  type: z.enum(EVENT_TYPES),
  /** Unix ms when it was sent, for a lag line in the consumer's log. */
  sentAt: z.number().int(),
})
export type EventMessage = z.infer<typeof EventMessageSchema>

/** The slice of Cloudflare's `Queue` used here. */
export interface EventSender {
  send(body: EventMessage, options?: { delaySeconds?: number }): Promise<unknown>
}

let sender: EventSender | null = null

export function setEventSender(next: EventSender | null): void {
  sender = next
}

/**
 * Send one event. Never throws: it runs right after a D1 write that already
 * committed, and a queue hiccup must not make that write look failed. A
 * dropped event waits for the hourly sweep instead. True when it was sent.
 */
export async function emitEvent(type: EventType, delaySeconds = 0): Promise<boolean> {
  if (!sender) return false
  try {
    const delay = Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.ceil(delaySeconds)))
    await sender.send({ v: 1, type, sentAt: Date.now() }, delay ? { delaySeconds: delay } : {})
    return true
  } catch (error) {
    logEvent('warn', 'events_emit_failed', { type, error: String(error) })
    return false
  }
}

/** Seconds until `due`, never under `floorSeconds`; null when nothing is due. */
export function delaySecondsUntil(
  due: Date | null,
  now: Date,
  floorSeconds: number,
): number | null {
  if (!due) return null
  const seconds = Math.ceil((due.getTime() - now.getTime()) / 1000)
  return Math.min(MAX_DELAY_SECONDS, Math.max(floorSeconds, seconds))
}

export const scheduledKey = (type: EventType) => `events:scheduled:${type}`

/**
 * Schedule a drain at `delaySeconds` unless one is already due by then. Every
 * alert in a poll emits `alerts.new`; the KV marker collapses their drain
 * chains to about one. KV lag can still start two, which idempotent drains
 * tolerate.
 */
export async function scheduleDrain(
  store: CacheStore,
  type: Extract<EventType, 'social.drain' | 'webhooks.drain'>,
  delaySeconds: number,
  now: Date,
): Promise<'scheduled' | 'already' | 'unsent'> {
  const at = now.getTime() + delaySeconds * 1000
  const existing = await store.get(scheduledKey(type))
  const existingAt = typeof existing === 'number' ? existing : Number(existing)
  if (Number.isFinite(existingAt) && existingAt > now.getTime() && existingAt <= at) {
    return 'already'
  }
  if (!(await emitEvent(type, delaySeconds))) return 'unsent'
  // KV's TTL floor is 60s; the marker only has to outlive the delay.
  await store.set(scheduledKey(type), at, { ttl: Math.max(60, delaySeconds + 120) })
  return 'scheduled'
}
