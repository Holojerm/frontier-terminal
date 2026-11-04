// GET /api/prices — the full catalog (one row per SKU key, newest revision,
// delta vs. the previous one) and the like-for-like matrix built over it.
// `as_of` rebuilds the catalog from the change log as it stood then.

import { queryPrices } from '../utils/terminal-db'
import { serveTerminalAsOf, terminalDb } from '../utils/terminal-handler'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'prices', limit: 60, windowSeconds: 60 })
  return serveTerminalAsOf(event, 'prices', (ctx) => queryPrices(terminalDb, ctx))
})
