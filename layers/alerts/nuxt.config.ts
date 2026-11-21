// The alerts layer: what the changes the store writes become once they leave it.
// The alert feed (/alerts, its permalinks, /api/alerts*, /alerts.xml, the MCP
// alert tools) and the overview band of what moved, with the alert axes and how
// an alert reads; the events queue's consumer and its hourly sweep; and outbound
// delivery: webhooks, the posts to the social layer, the press notes' send, and
// the digest subscribers (/subscribe, /api/subscribe/*) with their mail.
// Fork-owned, not in layers.lock.json. Supporting: it builds on core and reads
// the domains it names in domains.config.ts.
export default defineNuxtConfig({
  $meta: { name: 'alerts' },
  runtimeConfig: {
    // Derives every alert webhook's signing secret (layers/alerts/server/utils/webhook-sign.ts).
    // Unset = the webhook outbox does nothing. 32+ characters; rotating it
    // invalidates every webhook secret. A Worker secret:
    // `op read "op://…" | bunx wrangler secret put NUXT_WEBHOOK_SIGNING_KEY`.
    webhookSigningKey: '',
    // Which queue layers/alerts/server/plugins/events-queue.ts consumes. MUST
    // equal the `queue` in [[queues.consumers]] in wrangler.toml; a var, not a
    // constant, for the template's reason: a consumer that skips a batch acks it
    // by omission, so a name mismatch would drop events without a trace.
    // NUXT_EVENTS_QUEUE_NAME in [vars].
    eventsQueueName: 'frontier-terminal-events',
  },
})
