// One EVENTS batch, routed (the plugin, layers/terminal/server/plugins/events-queue.ts,
// filters by queue name first). Kept apart from the plugin so the routing is
// testable without Nitro.
//
// Each type runs once per batch however many of its messages arrived: a poll
// that writes ten alerts emits ten `alerts.new`, and one fan-out covers them
// all because every step reads the outboxes, not the message. A step that
// throws retries its messages; the rest of the batch is acked.

import { logEvent } from '#server/utils/log'

import { EventMessageSchema, type EventType } from './events'
import { fanOutAlerts, runSocialDrain, runWebhookDrain, type EventDeps } from './event-work'

/** The slice of Cloudflare's `Message` used here. */
export interface QueueMessageLike {
  id: string
  body: unknown
  attempts: number
  ack(): void
  retry(options?: { delaySeconds?: number }): void
}

export interface QueueBatchLike {
  queue: string
  messages: readonly QueueMessageLike[]
}

/** A failed step waits this long before its messages come back. */
export const EVENT_RETRY_DELAY_SECONDS = 60

const HANDLERS: Record<EventType, (deps: EventDeps) => Promise<unknown>> = {
  'alerts.new': fanOutAlerts,
  'social.drain': runSocialDrain,
  'webhooks.drain': runWebhookDrain,
}

export async function handleEventBatch(
  batch: QueueBatchLike,
  expectedQueue: string,
  deps: () => EventDeps,
): Promise<'handled' | 'unexpected-queue'> {
  // The hook fires for every queue bound to this Worker. A batch from another
  // queue is logged, never returned from silently: skipping without acking
  // acks the whole batch by omission.
  if (batch.queue !== expectedQueue) {
    logEvent('warn', 'events_queue_unexpected_queue', {
      queue: batch.queue,
      expected: expectedQueue,
      messages: batch.messages.length,
    })
    return 'unexpected-queue'
  }

  const byType = new Map<EventType, QueueMessageLike[]>()
  for (const message of batch.messages) {
    const parsed = EventMessageSchema.safeParse(message.body)
    if (!parsed.success) {
      // A body this build cannot read: written by an older deploy, or
      // corrupt. Retrying re-runs the same parse, so ack and say so.
      logEvent('error', 'events_queue_unparseable', { id: message.id, attempts: message.attempts })
      message.ack()
      continue
    }
    const list = byType.get(parsed.data.type) ?? []
    list.push(message)
    byType.set(parsed.data.type, list)
  }

  if (!byType.size) return 'handled'
  const built = deps()
  for (const [type, messages] of byType) {
    try {
      const result = await HANDLERS[type](built)
      logEvent('info', 'events_queue_handled', { type, messages: messages.length, result })
      for (const m of messages) m.ack()
    } catch (error) {
      logEvent('error', 'events_queue_failed', { type, error: String(error) })
      for (const m of messages) m.retry({ delaySeconds: EVENT_RETRY_DELAY_SECONDS })
    }
  }
  return 'handled'
}
