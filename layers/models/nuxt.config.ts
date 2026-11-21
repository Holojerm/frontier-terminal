// The models layer: what the labs ship and what they disclose about it. The
// release timeline, the launch tripwire, the model-floor launch alerts and the
// launch-coverage watch, and the misalignment disclosures (parsers, lanes, the
// report-page timelines); /releases, /disclosures, /api/releases and
// /api/disclosures with their panels, and get_releases and get_disclosures.
// Fork-owned, not in layers.lock.json. Builds on core and reads pricing's class
// map (domains.config.ts); it registers its lanes, change alerts and MCP tools
// through the app's server/registries/.
export default defineNuxtConfig({
  $meta: { name: 'models' },
})
