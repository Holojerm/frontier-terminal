// The companies layer: what the SEC filers around the labs file and say (EDGAR and SEC
// parsers, revenue, the prospectus, the hyperscalers' filed facts and guidance, the
// earnings-call reader, and company reference data). Builds on core only
// (domains.config.ts); registers its lanes, scopes, derived sources, judge reviews,
// recipes, MCP tools and export tables through server/registries/.
export default defineNuxtConfig({
  $meta: { name: 'companies' },
})
