// GET /api/incidents — status-page incidents per provider: counts for the
// newest 30 days against the 30 before, what is open now, and every
// incident in the last 90 days, each with provenance, and the monthly counts
// from the Internet Archive's copies of each feed before the live lanes began.

import { incidentArchiveStamp, queryIncidents } from '../utils/terminal-incidents'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'
import { rateLimitTerminal } from '#layers/core/server/utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'incidents', limit: 60, windowSeconds: 60 })
  const variant = await incidentArchiveStamp(terminalDb)
  return serveTerminal(event, 'incidents', (ctx) => queryIncidents(terminalDb, ctx), { variant })
})
