// The terminal layer: Frontier Terminal's product code — the fetch pipeline, the thesis engine,
// the query layer, the pages and components, and their tables and tests. Fork-owned: authored
// here, not vendored, so not in layers.lock.json. Depends on core only; pipeline, theses and
// terminal import each other, so they are one layer.
export default defineNuxtConfig({
  $meta: { name: 'terminal' },
  runtimeConfig: {
    // Derives every alert webhook's signing secret (layers/terminal/server/utils/webhook-sign.ts).
    // Unset = the webhook outbox does nothing. 32+ characters; rotating it
    // invalidates every webhook secret. A Worker secret:
    // `op read "op://…" | bunx wrangler secret put NUXT_WEBHOOK_SIGNING_KEY`.
    webhookSigningKey: '',
    // Optional. Authenticates the reliability:deploys read of the public smoke
    // test runs (layers/terminal/server/pipeline/reliability/deploys.ts), which
    // GitHub otherwise limits per shared Workers IP. Any token that can read
    // public repositories; a Worker secret: NUXT_GITHUB_TOKEN.
    githubToken: '',
    // The secret Cloudflare sends in `cf-webhook-auth` on each Workers Issues
    // automation call to POST /api/ops/issues. Unset = that route 404s. 32+
    // characters; a Worker secret: NUXT_ISSUES_WEBHOOK_SECRET.
    issuesWebhookSecret: '',
    // Which queue layers/terminal/server/plugins/events-queue.ts consumes. MUST
    // equal the `queue` in [[queues.consumers]] in wrangler.toml; a var, not a
    // constant, for the template's reason: a consumer that skips a batch acks it
    // by omission, so a name mismatch would drop events without a trace.
    // NUXT_EVENTS_QUEUE_NAME in [vars].
    eventsQueueName: 'frontier-terminal-events',
  },
})
