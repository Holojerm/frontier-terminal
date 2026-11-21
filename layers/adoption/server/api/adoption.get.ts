// GET /api/adoption: Ramp AI Index, npm/PyPI downloads and GitHub coding-agent PRs, read from
// the thesis recipes (layers/adoption/server/utils/terminal-adoption.ts).

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'adoption', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, ADOPTION_RECIPE_IDS)
  return serveTerminal(event, 'adoption', () => queryAdoption(terminalDb), { variant })
})
