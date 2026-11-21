// The companies layer: what the SEC filers around the labs file and say. The
// EDGAR and SEC parsers with their lanes, floors and derived sources; the
// filers, revenue, the prospectus and its floor; the hyperscalers' filed facts
// and guidance; the earnings-call reader; and the company reference data
// (identifiers, parents, dependencies, suppliers). /filings/[accession],
// /revenue, /exposure and /dependencies with their API routes, panels, MCP
// tools and export tables. Fork-owned, not in layers.lock.json. Builds on core
// only (domains.config.ts); it registers its lanes, scopes, derived sources,
// judge reviews, recipes, MCP tools and export tables through the app's
// server/registries/.
export default defineNuxtConfig({
  $meta: { name: 'companies' },
})
