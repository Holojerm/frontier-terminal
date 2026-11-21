// GET /api/releases — every SKU first listed after its source's baseline,
// newest first, with the price printed beside it when it was first seen.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'releases', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'releases', (ctx) => queryReleases(terminalDb, ctx))
})
