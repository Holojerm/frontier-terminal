// GET /api/prints — the hardware layer's monthly prints: Taiwan revenue for
// TSMC, the server builders, Accton and Delta, and Korea's chip exports under
// KOGL Type 1, each month as first printed and as revised, with each
// company's sourced ties to the labs and chip makers it builds for
// (layers/compute/server/utils/terminal-prints.ts). Read hourly by
// prints:read (layers/compute/server/prints/).

import { printsStamp } from '../prints/store'
import { rateLimitTerminal } from '#layers/core/server/utils/api-access'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'
import { queryPrints } from '../utils/terminal-prints'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'prints', limit: 60, windowSeconds: 60 })
  const variant = await printsStamp(terminalDb)
  return serveTerminal(event, 'prints', (ctx) => queryPrints(terminalDb, ctx), { variant })
})
