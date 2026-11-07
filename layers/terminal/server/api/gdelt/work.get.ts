// GET /api/gdelt/work — the next GDELT GKG files the press side has not read,
// oldest first, and the alerts (with their search terms) whose windows overlap
// them, for the Actions job (scripts/gdelt-search.ts) on the owner's Mac mini.
// Once nothing is unread, `figure_files` lists files read before reported
// figures existed, for the job to read again for those alone.
// Also hands it the User-Agent, so the job keeps no copy of it. Bearer-gated:
// it is the work queue for the one route that writes press candidates.

import { db } from '@nuxthub/db'

import { userAgentFor } from '../../pipeline/fetch'
import { GKG_BASE } from '../../pipeline/track-record/gkg'
import { figureBackfill } from '../../pipeline/reported/store'
import { gkgWork } from '../../pipeline/track-record/search'
import { requireGdeltToken } from '../../utils/gdelt-auth'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'gdelt', limit: 120, windowSeconds: 60 })
  await requireGdeltToken(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const config = useRuntimeConfig(event)
  const work = await gkgWork(db, new Date())
  return {
    user_agent: userAgentFor(GKG_BASE, { secContactEmail: '', appUrl: config.public.appUrl }),
    ...work,
    figure_files: work.files.length ? [] : await figureBackfill(db),
  }
})
