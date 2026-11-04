// Cron task: queue new alerts for licensee webhooks and send what is due
// (layers/terminal/server/utils/webhook-outbox.ts). Runs on the */5 tick.
// With no NUXT_WEBHOOK_SIGNING_KEY it returns before touching the database.
//
// Imports are explicit for the reason server/tasks/ops/alert.ts spells out.

import { db } from '@nuxthub/db'

import { logEvent } from '#server/utils/log'

import { SCHEMA_VERSION } from '../../utils/data-schema'
import { terminalStamp } from '../../utils/terminal-cache'
import { drainWebhookDeliveries, enqueueWebhookDeliveries } from '../../utils/webhook-outbox'
import { fetchWebhookSender, signingKeyRefusal } from '../../utils/webhook-sign'

export default defineTask({
  meta: {
    name: 'webhooks:deliver',
    description: 'Queue new alerts for licensee webhooks and send the due deliveries',
  },
  async run() {
    const runtime = useRuntimeConfig()
    const signingKey = runtime.webhookSigningKey
    if (signingKeyRefusal(signingKey)) return { result: { skipped: 'unconfigured' } }

    const now = new Date()
    const queued = await enqueueWebhookDeliveries(db, now)
    const drained = await drainWebhookDeliveries(db, {
      signingKey,
      origin: runtime.public.appUrl,
      schemaVersion: SCHEMA_VERSION,
      stamp: await terminalStamp(db),
      send: fetchWebhookSender(),
      now,
    })
    const { failing, ...counts } = drained
    if (queued.queued || Object.values(counts).some(Boolean) || failing.length) {
      logEvent('warn', 'webhooks_run', { ...queued, ...counts, failing: failing.length })
    }
    return { result: { ...queued, ...counts, failing: failing.length } }
  },
})
