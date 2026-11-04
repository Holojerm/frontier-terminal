// GET /api/hiring/history — open roles per provider and department, per
// day, reconstructed from the current set and the change log. Cached for
// the poll tick like every other terminal payload. `as_of` ends the series
// there, rebuilt from the set and log as they stood.

import { queryHiringHistory } from '../../utils/terminal-db'
import { serveTerminalAsOf, terminalDb } from '../../utils/terminal-handler'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'hiring-history', limit: 60, windowSeconds: 60 })
  return serveTerminalAsOf(event, 'hiring-history', (ctx) => queryHiringHistory(terminalDb, ctx))
})
