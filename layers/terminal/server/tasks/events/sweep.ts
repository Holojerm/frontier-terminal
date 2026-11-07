// Cron task: the hourly backstop for the EVENTS queue
// (layers/terminal/server/utils/events.ts). It runs the same fan-out and both
// drains a message would (event-work.ts › sweepEvents), so an alert whose
// `alerts.new` was never sent (no binding, a queue error) or a drain chain
// that broke is picked up within the hour. An unconfigured outbox is skipped
// before touching D1.
//
// Imports are explicit for the reason server/tasks/ops/watch.ts spells out.

import { logEvent } from '#server/utils/log'

import { sweepEvents } from '../../utils/event-work'
import { eventDeps } from '../../utils/event-runtime'
import { withHeartbeat } from '../../utils/task-heartbeat'

interface CloudflareTaskContext {
  cloudflare?: { env?: Record<string, unknown> }
}

const task = defineTask({
  meta: {
    name: 'events:sweep',
    description: 'Hourly backstop: offer new alerts to the outboxes and drain what is due',
  },
  async run({ context }) {
    const env = (context as CloudflareTaskContext | undefined)?.cloudflare?.env
    const result = await sweepEvents(eventDeps(env))
    const { fanOut, social, webhooks } = result
    // Quiet hours stay quiet: the queue normally did this work already, so a
    // sweep that found something is worth a line.
    if (fanOut.social || fanOut.webhooks || fanOut.press || social?.sent || webhooks?.delivered) {
      logEvent('warn', 'events_sweep_caught_up', { ...result })
    }
    return { result }
  },
})

export default withHeartbeat(task)
