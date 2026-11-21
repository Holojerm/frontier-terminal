// The models layer: what the labs ship and what they disclose about it (the
// release timeline, the launch tripwire, model-floor alerts, the launch-coverage
// watch, and the misalignment disclosures). Fork-owned, not in layers.lock.json.
// Builds on core and reads pricing's class map (domains.config.ts); it registers
// its lanes, change alerts and MCP tools through the app's server/registries/.
export default defineNuxtConfig({
  $meta: { name: 'models' },
})
