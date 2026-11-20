// GET /api/listed — every listed company the dependency graph, the suppliers
// table and the power table name, one row per ticker, with what each table
// says ties it to a lab (layers/terminal/server/utils/terminal-listed.ts).
// It joins /api/dependencies, /api/suppliers and /api/power-sites and adds no
// figure of its own. No `as_of`: two of the three have no point-in-time read.

import { rateLimitTerminal } from '../utils/api-access'
import { recipeRunsStamp } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { queryListed } from '../utils/terminal-listed'
import { VIEW_RECIPES } from '../utils/terminal-recipe-views'
import { SUPPLIERS_VERSION } from '../utils/terminal-suppliers'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'listed', limit: 60, windowSeconds: 60 })
  const power = await recipeRunsStamp(terminalDb, VIEW_RECIPES.powerSites)
  return serveTerminal(event, 'listed', (ctx) => queryListed(terminalDb, ctx), {
    variant: `${SUPPLIERS_VERSION}:${power}`,
  })
})
