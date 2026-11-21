// The compute layer. Fork-owned, not in layers.lock.json. Builds on core, and on
// companies for the hardware suppliers (domains.config.ts); registers its tables,
// recipes, MCP tools and exports through server/registries/ and server/db/schema.ts.
export default defineNuxtConfig({
  $meta: { name: 'compute' },
  runtimeConfig: {
    // EIA API v2 key for grid load (layers/compute/server/power/eia-api.ts), sent as the
    // X-Api-Key header to api.eia.gov only, never in a URL. Empty = the EIA-930 six-month
    // files are read instead, as they are for 2018 and whenever the API fails. A Worker
    // secret: `op read "op://Agents/eia/credential" | bunx wrangler secret put NUXT_EIA_API_KEY`.
    eiaApiKey: '',
  },
})
