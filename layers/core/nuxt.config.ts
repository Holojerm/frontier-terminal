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
  },
})
