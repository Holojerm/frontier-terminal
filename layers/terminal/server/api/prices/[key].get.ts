// GET /api/prices/<entity_key> — one SKU's observations: every change row
// plus the current entity row, each with the fetch it was read from. The
// key is part of the cache key. `as_of` cuts the series at that instant.
// Archived points (the Internet Archive backfill) come first, basis 'archived'.

import { z } from 'zod'

import { PERMALINK_LIMIT } from '../../utils/rate-limits'
import { queryPriceHistory } from '../../utils/terminal-db'
import { serveTerminalAsOf, terminalDb } from '../../utils/terminal-handler'
import { rateLimitTerminal } from '../../utils/api-access'

// modelKey() output: `model:<provider>:<slug>[:<tier>]` (layers/terminal/server/pipeline/contracts/keys.ts).
const keySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^model:[a-z]+:[^\s/]+$/)

export default defineEventHandler(async (event) => {
  // 120 did not clear the 378 SKU permalinks the sitemap lists, so two thirds
  // of every crawl were answered with a throttle. PERMALINK_LIMIT is sized to
  // the family.
  await rateLimitTerminal(event, {
    name: 'price-history',
    limit: PERMALINK_LIMIT,
    windowSeconds: 60,
  })
  const parsed = keySchema.safeParse(getRouterParam(event, 'key'))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Not a SKU key' })
  const key = parsed.data

  const history = await serveTerminalAsOf(
    event,
    'price-history',
    (ctx) => queryPriceHistory(terminalDb, ctx, key),
    key,
    true,
  )
  if (history === null) throw createError({ statusCode: 404, message: 'SKU not found' })
  return history
})
