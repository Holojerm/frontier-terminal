// GET /api/coverage — per source: newest snapshot, how the last run ended,
// snapshot count, the audit's caveat; plus the deliberate cuts, the table
// totals, and what /export serves.

import { queryCoverage } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'coverage', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'coverage', (ctx) => queryCoverage(terminalDb, ctx))
})
