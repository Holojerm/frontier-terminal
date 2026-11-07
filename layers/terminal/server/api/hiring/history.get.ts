// GET /api/hiring/history — open roles per provider and department, per
// day, reconstructed from the current set and the change log. Cached for
// the poll tick like every other terminal payload. `as_of` ends the series
// there, rebuilt from the set and log as they stood. Each lab's `archived`
// points are the Internet Archive's copies of its board from before then.

import { queryHiringHistory } from '../../utils/terminal-db'
import { serveTerminal, terminalDb } from '../../utils/terminal-handler'
import { rateLimitTerminal } from '../../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'hiring-history', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'hiring-history', (ctx) => queryHiringHistory(terminalDb, ctx), {
    asOf: 'hiring',
  })
})
