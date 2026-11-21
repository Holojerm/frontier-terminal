// The alerts layer: what stored changes become once they leave the store. The alert feed
// (/alerts, permalinks, /api/alerts*, /alerts.xml, the MCP alert tools), the overview band,
// the events queue's consumer and hourly sweep, and outbound delivery (webhooks, social
// posts, press notes, digest subscribers). Builds on core and reads the domains it names in
// domains.config.ts.
export default defineNuxtConfig({
  $meta: { name: 'alerts' },
  runtimeConfig: {
    // Derives every alert webhook's signing secret (layers/alerts/server/utils/webhook-sign.ts).
    // Unset = the webhook outbox does nothing. 32+ characters; rotating it
    // invalidates every webhook secret. A Worker secret:
    // `op read "op://…" | bunx wrangler secret put NUXT_WEBHOOK_SIGNING_KEY`.
    webhookSigningKey: '',
    // Which queue layers/alerts/server/plugins/events-queue.ts consumes. MUST equal the
    // `queue` in [[queues.consumers]] in wrangler.toml: a consumer that skips a batch acks
    // it by omission, so a mismatch drops events without a trace. NUXT_EVENTS_QUEUE_NAME in
    // [vars].
    eventsQueueName: 'frontier-terminal-events',
  },
})
