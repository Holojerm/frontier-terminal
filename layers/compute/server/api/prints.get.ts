// GET /api/prints: the hardware layer's monthly prints (Korea's under KOGL Type 1),
// every month as first printed and as revised, with each company's sourced ties
// (layers/compute/server/utils/terminal-prints.ts). Read hourly by prints:read.

import { printsStamp } from '../prints/store'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'prints', limit: 60, windowSeconds: 60 })
  const variant = await printsStamp(terminalDb)
  return serveTerminal(event, 'prints', (ctx) => queryPrints(terminalDb, ctx), { variant })
})
