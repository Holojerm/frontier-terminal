// GET /api/adoption — Enterprise adoption (Ramp AI Index), SDK and coding-agent downloads (npm, PyPI) and coding-agent pull requests (GitHub). Read from the thesis recipes
// (layers/adoption/server/utils/terminal-adoption.ts); every figure cites its source and fetch time.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'adoption', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, ADOPTION_RECIPE_IDS)
  return serveTerminal(event, 'adoption', () => queryAdoption(terminalDb), { variant })
})
