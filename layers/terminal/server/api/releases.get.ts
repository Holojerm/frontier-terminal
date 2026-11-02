// GET /api/releases — every SKU first listed after its source's baseline,
// newest first, with the price printed beside it when it was first seen.

import { queryReleases } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'releases', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'releases', (ctx) => queryReleases(terminalDb, ctx))
})
