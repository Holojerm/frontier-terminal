// GET /api/disclosures — each lab's own misalignment-disclosure index:
// every report and notice in the lab's words, the discovery and publication
// dates printed on each report's page, and the median days between them.
// Every other tracked lab publishes no index and is a stated cut.

import { queryDisclosures } from '../utils/terminal-disclosures'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'disclosures', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'disclosures', (ctx) => queryDisclosures(terminalDb, ctx))
})
