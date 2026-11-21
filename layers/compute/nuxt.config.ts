// The compute layer: GPU rental prices, Epoch AI's data centers and the
// utilization reads, who powers each lab site and the grid load around it,
// and the hardware prints with /hardware. Fork-owned, not in layers.lock.json.
// Builds on core, and on companies for the hardware suppliers /hardware lists
// (domains.config.ts); it registers its tables, recipes, MCP tools
// and export tables through the app's server/registries/ and server/db/schema.ts.
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
