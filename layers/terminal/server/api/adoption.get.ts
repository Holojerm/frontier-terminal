// GET /api/adoption — Enterprise adoption (Ramp AI Index), SDK and coding-agent downloads (npm, PyPI) and coding-agent pull requests (GitHub). Read from the thesis recipes
// (layers/terminal/server/utils/terminal-recipe-views.ts); every figure cites its source and fetch time.

import { recipeRunsStamp } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { queryAdoption, VIEW_RECIPES } from '../utils/terminal-recipe-views'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'adoption', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, VIEW_RECIPES.adoption)
  return serveTerminal(event, 'adoption', () => queryAdoption(terminalDb), variant)
})
