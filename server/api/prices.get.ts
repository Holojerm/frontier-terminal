// GET /api/prices — the full catalog (one row per SKU key, newest revision,
// delta vs. the previous one) and the like-for-like matrix built over it.

import { queryPrices } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'prices', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'prices', (ctx) => queryPrices(terminalDb, ctx))
})
