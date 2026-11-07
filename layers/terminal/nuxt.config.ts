// The terminal layer: Frontier Terminal's product code — the fetch pipeline, the thesis engine,
// the query layer, the pages and components, and their tables and tests. Fork-owned: authored
// here, not vendored, so not in layers.lock.json. Depends on core only; pipeline, theses and
// terminal import each other, so they are one layer.
export default defineNuxtConfig({
  $meta: { name: 'terminal' },
  runtimeConfig: {
    // Owner mail (layers/terminal/server/utils/owner-mail.ts): the weekly thesis
    // digest and the press brief. `to` must be the verified destination the
    // [[send_email]] OWNER_EMAIL binding is pinned to; `from` must be on a zone
    // in the account with Email Routing enabled. Either empty = those mails are
    // skipped. NUXT_OWNER_EMAIL_TO / NUXT_OWNER_EMAIL_FROM in [vars]; not secrets.
    ownerEmailTo: '',
    ownerEmailFrom: '',
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
    // Which queue layers/terminal/server/plugins/events-queue.ts consumes. MUST
    // equal the `queue` in [[queues.consumers]] in wrangler.toml; a var, not a
    // constant, for the template's reason: a consumer that skips a batch acks it
    // by omission, so a name mismatch would drop events without a trace.
    // NUXT_EVENTS_QUEUE_NAME in [vars].
    eventsQueueName: 'frontier-terminal-events',
  },
})
