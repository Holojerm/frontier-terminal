// GET /api/prices/<entity_key> — one SKU's observations: every change row
// plus the current entity row, each with the fetch it was read from. The
// key is part of the cache key.

import { z } from 'zod'

import { queryPriceHistory } from '../../utils/terminal-db'
import { serveTerminal, terminalDb } from '../../utils/terminal-handler'

// modelKey() output: `model:<provider>:<slug>[:<tier>]` (server/pipeline/contracts/keys.ts).
const keySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^model:[a-z]+:[^\s/]+$/)

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'price-history', limit: 120, windowSeconds: 60 })
  const parsed = keySchema.safeParse(getRouterParam(event, 'key'))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Not a SKU key' })
  const key = parsed.data

  const history = await serveTerminal(
    event,
    'price-history',
    (ctx) => queryPriceHistory(terminalDb, ctx, key),
    key,
  )
  if (history === null) throw createError({ statusCode: 404, message: 'SKU not found' })
  return history
})
