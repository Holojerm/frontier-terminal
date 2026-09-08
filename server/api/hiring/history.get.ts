// GET /api/hiring/history — open roles per provider and department, per
// day, reconstructed from the current set and the change log. Cached for
// the poll tick like every other terminal payload.

import { queryHiringHistory } from '../../utils/terminal-db'
import { serveTerminal, terminalDb } from '../../utils/terminal-handler'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'hiring-history', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'hiring-history', (ctx) => queryHiringHistory(terminalDb, ctx))
})
