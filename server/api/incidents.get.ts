// GET /api/incidents — status-page incidents per provider: counts for the
// newest 30 days against the 30 before, what is open now, and every
// incident in the last 90 days, each with provenance. xAI is a stated cut.

import { queryIncidents } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'incidents', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'incidents', (ctx) => queryIncidents(terminalDb, ctx))
})
