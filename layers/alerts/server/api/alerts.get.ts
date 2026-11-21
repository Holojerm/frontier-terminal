// GET /api/alerts?tier=&lab=&topic=&cursor=&limit=: newest first, cited change rows
// resolved. `tier` (layers/core/shared/utils/terminal-tiers.ts): `alert` (notable,
// critical), `critical` or `notable` alone, `info` (minor changes; `ticker` still
// accepted), or `all`. `lab` and `topic` keep alerts citing a row from that lab or axis.
// `cursor` is a page's `next_cursor`. Every parameter is in the cache key. `as_of` returns
// the alerts the store held at that instant (terminal-asof.ts › alertsKnownAt).

import { z } from 'zod'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  tier: z.preprocess(tierFilterOf, z.enum(ALERT_TIER_FILTERS).default('all')),
  lab: z.enum([...LABS, 'other']).optional(),
  topic: z.enum(ALERT_AXES).optional(),
  cursor: z
    .string()
    .max(200)
    .transform((s, ctx) => {
      const cursor = parseAlertCursor(s)
      if (!cursor) ctx.addIssue({ code: 'custom', message: 'not a next_cursor' })
      return cursor ?? z.NEVER
    })
    .optional(),
})

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'alerts', limit: 60, windowSeconds: 60 })
  const { limit, tier, lab, topic, cursor } = await getValidatedQuery(event, querySchema.parse)
  const filter = { lab, topic, cursor }
  const variant = [
    tier,
    limit,
    lab ?? '',
    topic ?? '',
    cursor ? `${cursor.created_at}~${cursor.id}` : '',
  ].join(':')
  return serveTerminal(
    event,
    'alerts',
    (ctx) => queryAlerts(terminalDb, ctx, limit, tier, filter),
    {
      // The unfiltered first page keeps the key it always had, so the cache entries other pages read stay warm.
      variant: lab || topic || cursor ? variant : `${tier}:${limit}`,
      asOf: 'snapshot',
    },
  )
})
