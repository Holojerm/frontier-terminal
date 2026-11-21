// The core layer: what every domain builds on. The ingest store and its
// contracts, the query plumbing every JSON route and MCP tool serves through,
// the export and MCP frameworks, API keys, the events queue's producer, task
// heartbeats and ops severity. Fork-owned, not in layers.lock.json.
//
// It names no domain. A registry that lists every domain (lanes, MCP tools,
// export tables, recipes) is assembled at the app root in server/registries/,
// and core reads it from there through `#server/registries/…`.
// scripts/check-domains.ts enforces both.
export default defineNuxtConfig({
  $meta: { name: 'core' },
  runtimeConfig: {
    // Bearer the judge routine presents to /api/judge/* (layers/core/server/utils/judge-auth.ts).
    // Unset = those routes 404 and no judge exists. Same shape and floor as the
    // fleet token; a Worker secret: `wrangler secret put NUXT_JUDGE_TOKEN`.
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
    // weekly digest fans out to confirmed subscribers through Resend. Either
    // empty = the whole feature is off: no form, those routes 404, no fan-out.
    // The key is a Worker secret (`op read "op://…" | bunx wrangler secret put
    // NUXT_RESEND_API_KEY`); the from address is a var, on a domain verified in
    // Resend. NUXT_RESEND_API_KEY / NUXT_SUBSCRIBE_EMAIL_FROM.
    resendApiKey: '',
    subscribeEmailFrom: '',
  },
})
