// GET /api/spend — implied OpenRouter-channel spend share: the 7-day token
// share joined to each vendor's list prices, as a low/high range per lab
// with the coverage of the join. Third-party channel, disclosed as such.

import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { querySpend } from '../utils/terminal-spend'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'spend', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'spend', (ctx) => querySpend(terminalDb, ctx))
})
