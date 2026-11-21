// The press layer: what the press reported, and how it did against the filings.
// GDELT's GKG files (the /api/gdelt/* routes the Mac mini's job posts to) and the
// labs' newsroom feeds; the track record, which times each alert against both;
// the reported articles and figures the judge reads; the ground truth, which
// scores those reports against later filings; and the press notes sent to
// reporters on a registration filing. /ground-truth with its API routes, panels,
// MCP tools and export tables. Fork-owned, not in layers.lock.json. Builds on
// core and companies (domains.config.ts); it registers its judge reviews,
// recipes, MCP tools and export tables through the app's server/registries/.
export default defineNuxtConfig({
  $meta: { name: 'press' },
})
