// GET /alerts.xml — the alert feed as Atom, for a reader that wants to be
// told rather than to come and look. Same cached payload as /api/alerts;
// server/utils/terminal-feed.ts owns the document.

import { queryAlerts } from '../utils/terminal-db'
import { buildAlertsAtom } from '../utils/terminal-feed'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'

const FEED_ENTRIES = 100

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'alerts-feed', limit: 60, windowSeconds: 60 })
  const config = useRuntimeConfig()

  const alerts = await serveTerminal(
    event,
    'alerts',
    (ctx) => queryAlerts(terminalDb, ctx, FEED_ENTRIES),
    String(FEED_ENTRIES),
  )

  setResponseHeader(event, 'Content-Type', 'application/atom+xml; charset=utf-8')
  return buildAlertsAtom({
    appName: config.public.appName,
    appUrl: config.public.appUrl,
    alerts: alerts.rows,
    fallbackUpdated: alerts.as_of ?? alerts.computed_at,
  })
})
