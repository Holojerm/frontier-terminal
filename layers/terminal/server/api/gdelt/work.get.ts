// GET /api/gdelt/work — the next GDELT GKG files the press side has not read,
// oldest first, and the vocabulary whose words decide which rows the job posts
// back, for the Actions job (scripts/gdelt-search.ts) on the owner's Mac mini.
// Also hands it the User-Agent, so the job keeps no copy of it. Bearer-gated:
// it is the work queue for the route that keeps the rows press is matched on.

import { db } from '@nuxthub/db'

import { userAgentFor } from '../../pipeline/fetch'
import { GKG_BASE } from '../../pipeline/track-record/gkg'
import { gkgWork } from '../../pipeline/track-record/search'
import { requireGdeltToken } from '../../utils/gdelt-auth'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'gdelt', limit: 120, windowSeconds: 60 })
  await requireGdeltToken(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const config = useRuntimeConfig(event)
  return {
    user_agent: userAgentFor(GKG_BASE, { secContactEmail: '', appUrl: config.public.appUrl }),
    ...(await gkgWork(db, new Date())),
  }
})
