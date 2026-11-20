// GET /api/listed?lab= — every listed company the dependency graph, the
// suppliers table and the power table name, one row per ticker, with what each
// table says ties it to a lab (layers/terminal/server/utils/terminal-listed.ts).
// It joins /api/dependencies, /api/suppliers and /api/power-sites and adds no
// figure of its own. `lab` keeps the companies tied to that lab (as it or its
// parent, by filing, or by site), with counts for that set. No `as_of`: two of
// the three have no point-in-time read.

import { suppliersStamp } from '../suppliers/store'
import { rateLimitTerminal } from '../utils/api-access'
import { recipeRunsStamp } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { labQuerySchema, listedForLab } from '../utils/terminal-lab-cuts'
import { queryListed } from '../utils/terminal-listed'
import { VIEW_RECIPES } from '../utils/terminal-recipe-views'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'listed', limit: 60, windowSeconds: 60 })
  const { lab } = await getValidatedQuery(event, labQuerySchema.parse)
  const [power, suppliers] = await Promise.all([
    recipeRunsStamp(terminalDb, VIEW_RECIPES.powerSites),
    suppliersStamp(terminalDb),
  ])
  const data = await serveTerminal(event, 'listed', (ctx) => queryListed(terminalDb, ctx), {
    variant: `${suppliers}:${power}`,
  })
  return lab ? listedForLab(data, lab) : data
})
