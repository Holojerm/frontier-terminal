// The terminal layer: Frontier Terminal's product code — the fetch pipeline, the thesis engine,
// the query layer, the pages and components, and their tables and tests. Fork-owned: authored
// here, not vendored, so not in layers.lock.json. Depends on core only; pipeline, theses and
// terminal import each other, so they are one layer.
export default defineNuxtConfig({
  $meta: { name: 'terminal' },
  runtimeConfig: {
    // Derives every alert webhook's signing secret (layers/terminal/server/utils/webhook-sign.ts).
    // Unset = the webhooks:deliver cron does nothing. 32+ characters; rotating it
    // invalidates every webhook secret. A Worker secret:
    // `op read "op://…" | bunx wrangler secret put NUXT_WEBHOOK_SIGNING_KEY`.
    webhookSigningKey: '',
  },
})
