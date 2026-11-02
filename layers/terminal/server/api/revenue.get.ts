// GET /api/revenue — disclosed revenue per lab, primary source only: XBRL
// company facts for each tagged filer (today SPCX, xAI's parent), and an
// explicit "no audited disclosure" for the rest. Cached for the poll tick.

import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { queryRevenue } from '../utils/terminal-revenue'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'revenue', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'revenue', (ctx) => queryRevenue(terminalDb, ctx))
})
