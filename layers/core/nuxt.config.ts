// The core layer: the ingest store, the query plumbing behind every JSON route
// and MCP tool, the export and MCP frameworks, recipes, API keys, the events
// queue's producer, task heartbeats and ops severity. It names no domain:
// domain registries live in server/registries/ (read through
// `#server/registries/…`), and scripts/check-domains.ts enforces both.
export default defineNuxtConfig({
  $meta: { name: 'core' },
  modules: ['@vueuse/nuxt'],
  runtimeConfig: {
    // Bearer the judge routine presents to /api/judge/* (layers/core/server/utils/judge-auth.ts).
    // Unset = those routes 404. Same shape and length floor as the fleet token;
    // a Worker secret: `wrangler secret put NUXT_JUDGE_TOKEN`.
    judgeToken: '',
    // Owner mail (layers/core/server/utils/owner-mail.ts): the weekly thesis
    // digest and the press brief. `to` must be the verified destination the
    // [[send_email]] OWNER_EMAIL binding is pinned to; `from` must be on a zone
    // in the account with Email Routing enabled. Either empty = those mails are
    // skipped. NUXT_OWNER_EMAIL_TO / NUXT_OWNER_EMAIL_FROM in [vars]; not secrets.
    ownerEmailTo: '',
    ownerEmailFrom: '',
    // Public digest subscriptions (layers/core/server/utils/subscribe-config.ts).
    // Both set = the subscribe form renders, /api/subscribe/* answers and the
    // weekly digest fans out to confirmed subscribers through Resend; either
    // empty = no form, those routes 404, no fan-out. NUXT_RESEND_API_KEY is a
    // Worker secret; NUXT_SUBSCRIBE_EMAIL_FROM is a var on a domain verified in Resend.
    resendApiKey: '',
    subscribeEmailFrom: '',
    // Optional. Sent by the core fetcher to api.github.com/search/* (the adoption
    // layer's agent-PR counts), and authenticates the reliability:deploys read of
    // the public smoke test runs (layers/reliability/server/pipeline/reliability/deploys.ts),
    // which GitHub otherwise limits per shared Workers IP. Any token that can read
    // public repositories; a Worker secret: NUXT_GITHUB_TOKEN.
    githubToken: '',
  },
})
