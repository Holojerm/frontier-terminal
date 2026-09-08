// GET /api/alerts/:id — one alert with every cited change row in full
// (before and after, field by field), for the permalink page. Ids are
// contentHash() output (server/pipeline/judge/contract.ts › buildAlertRows),
// so anything that is not 64 hex characters is a 404 before D1 is asked.

import { z } from 'zod'

import { queryAlert } from '../../utils/terminal-db'
import { serveTerminal, terminalDb } from '../../utils/terminal-handler'

const idSchema = z.string().regex(/^[0-9a-f]{64}$/)

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'alerts', limit: 60, windowSeconds: 60 })
  const id = idSchema.safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 404, message: 'No such alert' })

  const data = await serveTerminal(
    event,
    'alert',
    (ctx) => queryAlert(terminalDb, ctx, id.data),
    id.data,
  )
  if (data === null) throw createError({ statusCode: 404, message: 'No such alert' })
  return data
})
