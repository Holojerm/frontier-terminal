// GET /api/rankings — demand share from OpenRouter's usage rankings: 7-day
// token share per lab with the change against the prior 7 days, each lab's
// top models, the 30-day daily series, and the CC BY 4.0 citation. Cached in
// KV for the current poll tick (server/utils/terminal-handler.ts).

import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { queryRankings } from '../utils/terminal-rankings'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'rankings', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'rankings', (ctx) => queryRankings(terminalDb, ctx))
})
