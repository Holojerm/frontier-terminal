// The pricing layer: API price lists and model catalogs, the like-for-like class map and its
// drift check, the judge's re-mappings and price-list reads, archived price lists and rate
// limits, published rate limits, and /prices. Fork-owned (not in layers.lock.json). Builds on
// core only (domains.config.ts) and registers through the app's server/registries/ and
// server/db/schema.ts.
export default defineNuxtConfig({
  $meta: { name: 'pricing' },
})
