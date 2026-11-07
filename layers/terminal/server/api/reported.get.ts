// GET /api/reported — each private lab's revenue, valuation and funding as
// press headlines state them (GDELT), labeled by the judge and checked
// against the headline, with the newest report and a median per quarter
// (layers/terminal/server/utils/terminal-reported.ts). Never mixed with
// filed revenue (/api/revenue). `as_of` returns what the store held then:
// every table behind it is append-only.

import { queryReported, reportedStamp } from '../utils/terminal-reported'
import { serveTerminalAsOf, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'reported', limit: 60, windowSeconds: 60 })
  // Articles and readings land between polls, so they key the cache too.
  const variant = await reportedStamp(terminalDb)
  return serveTerminalAsOf(event, 'reported', (ctx) => queryReported(terminalDb, ctx), variant)
})
