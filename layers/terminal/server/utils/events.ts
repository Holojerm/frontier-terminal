// The EVENTS queue: what replaced the five-minute clock for alert delivery.
//
// A new alert used to wait for the */5 tick, and that tick read D1 every five
// minutes whether or not anything was owed. Now the code that writes alerts
// emits `alerts.new`, and the consumer (layers/terminal/server/plugins/events-queue.ts)
// fans out to the social outbox, the webhook outbox and the press briefs, then
// schedules a delayed drain for each outbox at its earliest due row. A drain
// that leaves work behind schedules itself again; an empty outbox schedules
// nothing, so a quiet day costs nothing.
//
// The queue carries triggers, never state. social_posts, webhook_deliveries
// and the press KV markers stay the record, and every handler is idempotent,
// so a duplicate or replayed message is harmless and a lost one is picked up
// by the hourly events:sweep backstop.
//
// Emitting goes through a module-level sender, null by default, so pipeline
// code and its tests never need a Worker env. The plugin installs the real one.

import { z } from 'zod'

import { logEvent } from '#server/utils/log'

import type { CacheStore } from './terminal-cache'

/** Binding name — must match `binding` in `[[queues.producers]]` in wrangler.toml. */
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
 * Schedule a drain at `delaySeconds` unless one is already scheduled at or
 * before that moment. Every alert in a poll emits `alerts.new`, and each
 * fan-out would otherwise start its own self-renewing drain chain; the KV
 * marker collapses them to roughly one. KV is eventually consistent, so two
 * chains can still start together; they stay harmless because drains are
 * idempotent, and the next schedule sees the marker.
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
