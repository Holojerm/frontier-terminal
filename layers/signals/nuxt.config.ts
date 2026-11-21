// The signals layer: the signal registry, the event-study harness that tests each series
// against the stocks it is expected to lead (with a held-out sample), the forward calls,
// and the Databento market data only the harness reads. Fork-owned, not in
// layers.lock.json. Builds on core and the domains whose series it tests
// (domains.config.ts). It feeds the earnings-call reader its forward-call concepts through
// the app's server/registries/call-concepts.ts, and registers its MCP tools and export
// tables beside it.
export default defineNuxtConfig({
  $meta: { name: 'signals' },
})
