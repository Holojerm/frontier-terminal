// The terminal layer: every domain not yet split out of it — the parsers and lanes, the thesis
// layer, the per-domain queries, the pages and components, and their tables and tests. Fork-owned:
// authored here, not vendored, so not in layers.lock.json. Builds on the core layer
// (domains.config.ts); the domains leave it one layer at a time, and what stays is the shell.
export default defineNuxtConfig({
  $meta: { name: 'terminal' },
  runtimeConfig: {
    // Optional. Authenticates the reliability:deploys read of the public smoke
    // test runs (layers/reliability/server/pipeline/reliability/deploys.ts), which
    // GitHub otherwise limits per shared Workers IP. Any token that can read
    // public repositories; a Worker secret: NUXT_GITHUB_TOKEN.
    githubToken: '',
  },
})
