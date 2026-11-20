// GET /api/probes — the hourly latency probes as a strain reading per lab:
// peak against off-peak throughput and the share of probes rate limited or
// failed, per UTC day, with each lab's newest probe
// (layers/terminal/server/utils/terminal-probes.ts). Takes no input; `as_of`
// is refused, since each day is dated and nothing here is rewritten later.

import { rateLimitTerminal } from '../utils/api-access'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { probesStamp, queryProbes } from '../utils/terminal-probes'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'probes', limit: 60, windowSeconds: 60 })
  // Probes land hourly, between polls, so they key the cache too.
  const variant = await probesStamp(terminalDb)
  return serveTerminal(event, 'probes', (ctx) => queryProbes(terminalDb, ctx), { variant })
})
