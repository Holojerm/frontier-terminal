// GET /api/overview — the signal band: what moved, the newest alerts with
// their cited change rows, and the store's totals. Cached in KV for the
// current poll tick (layers/core/server/utils/terminal-handler.ts).

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'overview', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'overview', (ctx) => queryOverview(terminalDb, ctx))
})
