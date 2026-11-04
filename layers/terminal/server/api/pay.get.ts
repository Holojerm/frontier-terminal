// GET /api/pay — Posted US salary bands on OpenAI's and Anthropic's job boards, as median band midpoints per role family. Read from the thesis recipes
// (layers/terminal/server/utils/terminal-recipe-views.ts); every figure cites its source and fetch time.

import { recipeRunsStamp } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { queryPay, VIEW_RECIPES } from '../utils/terminal-recipe-views'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'pay', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, VIEW_RECIPES.pay)
  return serveTerminal(event, 'pay', () => queryPay(terminalDb), variant)
})
