// The talent layer: the labs' job boards (the careers parsers, their lanes and
// the Greenhouse redaction), the hiring floor and weekly roll-up, the archived
// boards, department clusters, posted pay, the listed companies' hiring, and
// /api/hiring, /api/hiring/history, /api/hiring/listed and /api/pay with their
// panels. Fork-owned, not in layers.lock.json. Builds on core only
// (domains.config.ts); it registers its tables, lanes, redaction, MCP tools,
// recipes, export tables and the clusters block through the app's
// server/registries/ and server/db/schema.ts.
export default defineNuxtConfig({
  $meta: { name: 'talent' },
})
