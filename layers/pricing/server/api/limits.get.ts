// GET /api/limits — The API rate limits OpenAI, Anthropic, xAI and Meta publish, per model, tier and metric, with the date of the last change. Read from the thesis recipes
// (layers/pricing/server/utils/terminal-limits.ts); every figure cites its source and fetch time.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'limits', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, LIMIT_RECIPE_IDS)
  return serveTerminal(event, 'limits', () => queryLimits(terminalDb), { variant })
})
