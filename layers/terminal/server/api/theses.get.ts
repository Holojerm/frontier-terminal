// GET /api/theses — every open thesis: claims, statuses against their kill
// conditions, and the readings behind them (layers/terminal/server/theses).

import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { queryTheses } from '../utils/terminal-theses'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'theses', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'theses', (ctx) => queryTheses(terminalDb, ctx))
})
