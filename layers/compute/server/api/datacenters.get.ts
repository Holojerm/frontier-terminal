// GET /api/datacenters — Epoch AI's estimate of current data-center power, total and per lab by named user. Read from the thesis recipes
// (layers/compute/server/utils/terminal-datacenters.ts); every figure cites its source and fetch time.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'datacenters', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, DATACENTER_RECIPES.datacenters)
  return serveTerminal(event, 'datacenters', () => queryDataCenters(terminalDb), { variant })
})
