// GET /api/prices/<entity_key> — one SKU's observations: every change row
// plus the current entity row, each with the fetch it was read from. The
// key is part of the cache key. `as_of` cuts the series at that instant.
// Archived points (the Internet Archive backfill) come first, basis 'archived'.

import { z } from 'zod'

// modelKey() output: `model:<provider>:<slug>[:<tier>]` (layers/core/server/utils/contracts/keys.ts).
const keySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^model:[a-z]+:[^\s/]+$/)

export default defineEventHandler(async (event) => {
  // PERMALINK_LIMIT is sized to the family: 120 throttled two thirds of every crawl of the 378
  // SKU permalinks the sitemap lists.
  await rateLimitTerminal(event, {
    name: 'price-history',
    limit: PERMALINK_LIMIT,
    windowSeconds: 60,
  })
  const parsed = keySchema.safeParse(getRouterParam(event, 'key'))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Not a SKU key' })
  const key = parsed.data

  const history = await serveTerminal(
    event,
    'price-history',
    (ctx) => queryPriceHistory(terminalDb, ctx, key),
    { variant: key, asOf: 'pricing' },
  )
  if (history === null) throw createError({ statusCode: 404, message: 'SKU not found' })
  return history
})
