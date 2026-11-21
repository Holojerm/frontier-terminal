// GET /api/coverage — per source: newest snapshot, how the last run ended,
// snapshot count, the audit's caveat; the thesis recipes and their last runs;
// plus the deliberate cuts, the table totals, and what /export serves.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'coverage', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb)
  return serveTerminal(event, 'coverage', (ctx) => queryCoverage(terminalDb, ctx), { variant })
})
