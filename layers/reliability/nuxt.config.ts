// The reliability layer: capacity strain and the feed's own record. Status parsers and lanes,
// incidents (live and archived), latency probes and the OpenRouter catalog they resolve
// targets from, the reliability record (source runs per day, poll ticks, filing detections,
// deploy checks), /api/incidents, /api/probes and /api/reliability with their panels, and
// get_incidents and get_probes. Fork-owned (not in layers.lock.json). Builds on core and
// reads pricing's class map (domains.config.ts); registers through the app's
// server/registries/ and server/db/schema.ts.
export default defineNuxtConfig({
  $meta: { name: 'reliability' },
})
