// GET /api/overview — the signal band: what moved, the newest alerts with
// their cited change rows, and the store's totals. Cached in KV for the
// current poll tick (server/utils/terminal-handler.ts).

import { queryOverview } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'overview', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'overview', (ctx) => queryOverview(terminalDb, ctx))
})
