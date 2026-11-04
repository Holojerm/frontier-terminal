// GET /api/prices — the full catalog (one row per SKU key, newest revision,
// delta vs. the previous one) and the like-for-like matrix built over it.
// `as_of` rebuilds the catalog from the change log as it stood then; before
// our first snapshot, from the Internet Archive backfill (terminal-archive.ts).

import { queryPrices } from '../utils/terminal-db'
import { serveTerminalAsOf, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'prices', limit: 60, windowSeconds: 60 })
  return serveTerminalAsOf(event, 'prices', (ctx) => queryPrices(terminalDb, ctx), '', true)
})
