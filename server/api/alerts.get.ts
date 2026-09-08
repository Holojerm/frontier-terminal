// GET /api/alerts?limit= — newest first, each with its cited change rows
// resolved. The limit is part of the cache key.

import { z } from 'zod'

import { queryAlerts } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'alerts', limit: 60, windowSeconds: 60 })
  const { limit } = await getValidatedQuery(event, querySchema.parse)
  return serveTerminal(event, 'alerts', (ctx) => queryAlerts(terminalDb, ctx, limit), String(limit))
})
