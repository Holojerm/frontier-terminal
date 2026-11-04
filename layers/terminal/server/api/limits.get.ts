// GET /api/limits — The API rate limits OpenAI, Anthropic, xAI and Meta publish, per model, tier and metric, with the date of the last change. Read from the thesis recipes
// (layers/terminal/server/utils/terminal-recipe-views.ts); every figure cites its source and fetch time.

import { recipeRunsStamp } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { queryLimits, VIEW_RECIPES } from '../utils/terminal-recipe-views'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'limits', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, VIEW_RECIPES.limits)
  return serveTerminal(event, 'limits', () => queryLimits(terminalDb), variant)
})
