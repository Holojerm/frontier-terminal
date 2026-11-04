// GET /api/hiring — open roles per provider from the current entity set,
// by department, with the caveats that travel with the data. `as_of` counts
// the job set rebuilt at that instant.

import { queryHiring } from '../utils/terminal-db'
import { serveTerminalAsOf, terminalDb } from '../utils/terminal-handler'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'hiring', limit: 60, windowSeconds: 60 })
  return serveTerminalAsOf(event, 'hiring', (ctx) => queryHiring(terminalDb, ctx))
})
