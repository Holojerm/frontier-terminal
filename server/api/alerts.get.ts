// GET /api/alerts?tier=&limit= — newest first, each with its cited change
// rows resolved. `tier` is the materiality split (shared/utils/terminal-tiers.ts):
// `alert` (notable, critical), `ticker` (info), or `all`. Both are part of
// the cache key.

import { z } from 'zod'

import { ALERT_TIER_FILTERS } from '#shared/utils/terminal-tiers'

import { queryAlerts } from '../utils/terminal-db'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  tier: z.enum(ALERT_TIER_FILTERS).default('all'),
})

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'alerts', limit: 60, windowSeconds: 60 })
  const { limit, tier } = await getValidatedQuery(event, querySchema.parse)
  return serveTerminal(
    event,
    'alerts',
    (ctx) => queryAlerts(terminalDb, ctx, limit, tier),
    `${tier}:${limit}`,
  )
})
