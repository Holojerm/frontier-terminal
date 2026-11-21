// GET /api/spend — implied OpenRouter-channel spend share: the 7-day token
// share joined to each vendor's list prices, as a low/high range per lab
// with the coverage of the join. Third-party channel, disclosed as such.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'spend', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'spend', (ctx) => querySpend(terminalDb, ctx))
})
