// GET /api/datacenters — Epoch AI's estimate of current data-center power, total and per lab by named user. Read from the thesis recipes
// (layers/terminal/server/utils/terminal-recipe-views.ts); every figure cites its source and fetch time.

import { recipeRunsStamp } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { queryDataCenters, VIEW_RECIPES } from '../utils/terminal-recipe-views'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'datacenters', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, VIEW_RECIPES.datacenters)
  return serveTerminal(event, 'datacenters', () => queryDataCenters(terminalDb), variant)
})
