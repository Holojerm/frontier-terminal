// The press layer: what the press reported, and how it did against the filings.
// GDELT's GKG files (the /api/gdelt/* routes the Mac mini's job posts to) and the
// labs' newsroom feeds back the track record (each alert timed against both), the
// reported figures the judge reads, the ground truth (those reports scored against
// later filings) and the press notes sent to reporters on a registration filing.
// Fork-owned, not in layers.lock.json. Builds on core and companies
// (domains.config.ts); it registers its judge reviews, recipes, MCP tools and
// export tables through the app's server/registries/.
export default defineNuxtConfig({
  $meta: { name: 'press' },
})
