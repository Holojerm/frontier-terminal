// GET /api/probes?lab= — the hourly latency probes as a strain reading per lab:
// peak against off-peak throughput and the share of probes rate limited or
// failed, per UTC day, with each lab's newest probe
// (layers/terminal/server/utils/terminal-probes.ts). `lab` keeps one lab's row,
// cut from the cached all-lab payload. `as_of` is refused, since each day is
// dated and nothing here is rewritten later.

import { rateLimitTerminal } from '#layers/core/server/utils/api-access'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'
import { labQuerySchema, probesForLab } from '../utils/terminal-lab-cuts'
import { probesStamp, queryProbes } from '../utils/terminal-probes'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'probes', limit: 60, windowSeconds: 60 })
  const { lab } = await getValidatedQuery(event, labQuerySchema.parse)
  const variant = await probesStamp(terminalDb)
  const data = await serveTerminal(event, 'probes', (ctx) => queryProbes(terminalDb, ctx), {
    variant,
  })
  return lab ? probesForLab(data, lab) : data
})
