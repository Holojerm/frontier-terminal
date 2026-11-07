// GET /api/hiring — open roles per provider from the current entity set,
// by department, with the caveats that travel with the data. `as_of` counts
// the job set rebuilt at that instant; before our first read of the boards,
// each lab's newest Internet Archive copy by then (terminal-archive.ts).

import { queryHiring } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'hiring', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'hiring', (ctx) => queryHiring(terminalDb, ctx), { asOf: 'hiring' })
})
