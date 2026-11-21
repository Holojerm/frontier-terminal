// The signals layer: the signal registry and the event-study harness that tests
// each series against the stocks it is expected to lead, with a held-out sample;
// the forward calls, estimated before a figure is filed and scored once it is;
// the Databento market data only the harness reads. The signals:prices and
// signals:run tasks, /signals with its API route, MCP tool and export tables.
// Fork-owned, not in layers.lock.json. Builds on core and the domains whose
// series it tests (domains.config.ts); it feeds the earnings-call reader its
// forward-call concepts through the app's server/registries/call-concepts.ts,
// and registers its MCP tools and export tables there too.
export default defineNuxtConfig({
  $meta: { name: 'signals' },
})
