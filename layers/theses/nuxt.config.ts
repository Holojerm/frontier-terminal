// The theses layer: arguments built on the terminal's data, each claim checked
// against a kill condition. The thesis definitions and their measured, recipe
// and judged inputs; the evaluator, which the judge's `judge:applied` hook runs
// after verdicts land (server/plugins/theses-judged.ts); the claim review the
// judge routine reads; the weekly digest (the theses:digest task, which hands
// alerts' subscriber fan-out the digest to build) and its sample page
// (/digest); /theses and /theses/[id] with their API route, MCP tools and export
// tables. Fork-owned, not in layers.lock.json. Builds on core and the domains
// whose data its claims read (domains.config.ts); it registers its judge
// review, recipe, MCP tools and export tables through the app's server/registries/.
export default defineNuxtConfig({
  $meta: { name: 'theses' },
})
