// GET /alerts.xml — the alert feed as Atom, for a reader that wants to be
// told rather than to come and look. Alerts only by default (notable,
// critical); `?include=info` adds the minor changes (`?include=ticker`, the
// old name, still does) and `?tier=critical` narrows it to critical alerts.
// Asking for both is a 400: they pull in opposite directions. Same cached
// payloads as /api/alerts; layers/terminal/server/utils/terminal-feed.ts owns the document.

import { z } from 'zod'

import { tierFilterOf } from '../../shared/utils/terminal-tiers'
import { queryAlerts } from '../utils/terminal-alerts'
import { buildAlertsAtom, type FeedTier } from '../utils/terminal-feed'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'

const FEED_ENTRIES = 100

const querySchema = z
  .object({
    include: z.preprocess(tierFilterOf, z.enum(['info']).optional()),
    tier: z.enum(['critical']).optional(),
  })
  .refine((q) => !(q.include && q.tier), {
    message: 'include=info and tier=critical cannot be combined',
  })

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'alerts-feed', limit: 60, windowSeconds: 60 })
  const config = useRuntimeConfig()
  const { include, tier: narrow } = await getValidatedQuery(event, querySchema.parse)
  const tier: FeedTier = narrow ?? (include === 'info' ? 'all' : 'alert')

  const alerts = await serveTerminal(
    event,
    'alerts',
    (ctx) => queryAlerts(terminalDb, ctx, FEED_ENTRIES, tier),
    { variant: `${tier}:${FEED_ENTRIES}` },
  )

  setResponseHeader(event, 'Content-Type', 'application/atom+xml; charset=utf-8')
  return buildAlertsAtom({
    appName: config.public.appName,
    appUrl: config.public.appUrl,
    alerts: alerts.rows,
    tier,
    fallbackUpdated: alerts.as_of ?? alerts.computed_at,
  })
})
