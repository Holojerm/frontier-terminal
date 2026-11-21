// GET /api/overview — the signal band: what moved, the newest alerts with
// their cited change rows, and the store's totals. Cached in KV for the
// current poll tick (layers/core/server/utils/terminal-handler.ts).

import { queryOverview } from '../utils/terminal-alerts'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'
import { rateLimitTerminal } from '#layers/core/server/utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'overview', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'overview', (ctx) => queryOverview(terminalDb, ctx))
})
