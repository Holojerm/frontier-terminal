// GET /api/rankings: OpenRouter demand share (7-day token share per lab and its change, top
// models, the 30-day series, the weekly history, the CC BY 4.0 citation). Cached in KV for
// the current poll tick (layers/core/server/utils/terminal-handler.ts).

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'rankings', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'rankings', (ctx) => queryRankings(terminalDb, ctx))
})
