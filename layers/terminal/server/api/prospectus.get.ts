// GET /api/prospectus — what each lab's own registration filings print beyond
// revenue: the statement of operations line by line, commitments, customer
// concentration, share counts and risk-factor headings with what each
// amendment changed. Empty `issuers` until a lab files. Cached for the poll tick.

import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { queryProspectus } from '../utils/terminal-prospectus'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'prospectus', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'prospectus', (ctx) => queryProspectus(terminalDb, ctx))
})
