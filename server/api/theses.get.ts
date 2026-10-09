// GET /api/theses — every open thesis: claims, statuses against their kill
// conditions, and the readings behind them (server/theses).

import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { queryTheses, thesesStamp } from '../utils/terminal-theses'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'theses', limit: 60, windowSeconds: 60 })
  const variant = await thesesStamp(terminalDb)
  return serveTerminal(event, 'theses', (ctx) => queryTheses(terminalDb, ctx), variant)
})
