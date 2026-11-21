// GET /api/parents — What Microsoft and Amazon tag about OpenAI and Anthropic in their newest 10-Q or 10-K. Read from the thesis recipes
// (layers/terminal/server/utils/terminal-recipe-views.ts); every figure cites its source and fetch time.

import { recipeRunsStamp } from '#layers/core/server/utils/terminal-db'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'
import { queryParents, VIEW_RECIPES } from '../utils/terminal-recipe-views'
import { rateLimitTerminal } from '#layers/core/server/utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'parents', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, VIEW_RECIPES.parents)
  return serveTerminal(event, 'parents', () => queryParents(terminalDb), { variant })
})
