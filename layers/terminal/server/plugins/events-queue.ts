// The EVENTS queue's producer wiring and consumer (layers/terminal/server/utils/events.ts
// says what the queue is for; event-consumer.ts routes a batch).
//
// Producer: emitEvent() sends through `globalThis.__env__.EVENTS`, which
// Nitro's cloudflare-module handler sets before every fetch, scheduled and
// queue invocation. It is read at send time, not here, because a plugin runs
// before any invocation has an env. Off Cloudflare the binding is absent and
// emitEvent() reports unsent, which leaves the work to the hourly sweep.
//
// Consumer: Nitro's preset already exports queue() and only `waitUntil`s the
// `cloudflare:queue` hook, so every ack() and retry() runs after the handler
// returned. That is safe because of Cloudflare's default that a consumer's
// batch is not acknowledged until its waitUntil promises settle, which
// wrangler.toml pins with `queue_consumer_wait_for_wait_until`. Do not remove
// that flag. The same shape as the template's email-queue consumer.

import { EVENTS_QUEUE_BINDING, setEventSender, type EventSender } from '../utils/events'
import { handleEventBatch, type QueueBatchLike } from '../utils/event-consumer'
import { eventDeps } from '../utils/event-runtime'

export default defineNitroPlugin((nitro) => {
  setEventSender({
    send: async (body, options) => {
      const env = (globalThis as { __env__?: Record<string, unknown> }).__env__
      const queue = env?.[EVENTS_QUEUE_BINDING] as EventSender | undefined
      if (!queue) throw new Error(`no ${EVENTS_QUEUE_BINDING} binding`)
      return queue.send(body, options)
    },
  })

  nitro.hooks.hook('cloudflare:queue', async ({ batch, env }) => {
    await handleEventBatch(
      batch as unknown as QueueBatchLike,
      useRuntimeConfig().eventsQueueName,
      () => eventDeps(env as Record<string, unknown> | undefined),
    )
  })
})
