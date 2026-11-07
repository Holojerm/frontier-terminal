// GET /api/alerts?tier=&limit= — newest first, each with its cited change
// rows resolved. `tier` is the materiality split (layers/terminal/shared/utils/terminal-tiers.ts):
// `alert` (notable, critical), `critical` alone, `info` (minor changes; `ticker`
// is its old name and still accepted), or `all`. Both are part of the cache key. `as_of` returns the alerts the store held at that instant
// (terminal-asof.ts › alertsKnownAt).

import { z } from 'zod'

import { ALERT_TIER_FILTERS, tierFilterOf } from '../../shared/utils/terminal-tiers'

import { queryAlerts } from '../utils/terminal-db'
import { serveTerminalAsOf, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  tier: z.preprocess(tierFilterOf, z.enum(ALERT_TIER_FILTERS).default('all')),
})

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'alerts', limit: 60, windowSeconds: 60 })
  const { limit, tier } = await getValidatedQuery(event, querySchema.parse)
  return serveTerminalAsOf(
    event,
    'alerts',
    (ctx) => queryAlerts(terminalDb, ctx, limit, tier),
    `${tier}:${limit}`,
  )
})
