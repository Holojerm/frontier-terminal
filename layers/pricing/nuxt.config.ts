// The pricing layer: each lab's API price lists and model catalogs, the
// like-for-like class map and its drift check, the judge's re-mappings and
// price-list reads, the archived price lists and rate limits, the published
// rate limits, and /prices. Fork-owned, not in layers.lock.json. Builds on
// core only (domains.config.ts); it registers its tables, lanes, the class
// map's tick input, its MCP tools and recipes through the app's
// server/registries/ and server/db/schema.ts.
export default defineNuxtConfig({
  $meta: { name: 'pricing' },
})
