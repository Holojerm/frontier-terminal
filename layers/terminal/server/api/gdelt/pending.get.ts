// GET /api/gdelt/pending — the GDELT searches that are due, oldest alert
// first, for the GitHub Actions job (scripts/gdelt-search.ts) to run. Also
// hands it the pace, the timeout and the User-Agent, so the job keeps no
// copy of those. Bearer-gated: it is the work queue for the one route that
// writes press candidates.

import { db } from '@nuxthub/db'

import { FETCH_TIMEOUT_MS, userAgentFor } from '../../pipeline/fetch'
import { GDELT_DOC_URL, GDELT_SPACING_MS } from '../../pipeline/track-record/gdelt'
import { dueGdeltSearches } from '../../pipeline/track-record/search'
import { requireGdeltToken } from '../../utils/gdelt-auth'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'gdelt', limit: 30, windowSeconds: 60 })
  await requireGdeltToken(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const config = useRuntimeConfig(event)
  return {
    spacing_ms: GDELT_SPACING_MS,
    timeout_ms: FETCH_TIMEOUT_MS,
    user_agent: userAgentFor(GDELT_DOC_URL, {
      secContactEmail: '',
      appUrl: config.public.appUrl,
    }),
    searches: await dueGdeltSearches(db, new Date()),
  }
})
