// POST /api/gdelt/figures — the figure rows of one GKG file the track record
// read before reported figures existed, for a file /api/gdelt/work listed under
// `figure_files`. The Worker parses and matches each row again before it keeps
// it (recordFigureFile). 409 for a file that is not listed or already read.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { z } from 'zod'

import { blobRawStore } from '../../pipeline/poll'
import { MAX_FIGURES_PER_FILE, recordFigureFile } from '../../pipeline/reported/store'
import { requireGdeltToken } from '../../utils/gdelt-auth'

/** A fetch time this far off the Worker's clock is refused: the job posts each file at once. */
const FETCHED_AT_SLACK_MS = 15 * 60_000

const Body = z.object({
  stamp: z.string().regex(/^\d{14}$/),
  fetched_at: z.string().datetime(),
  figures: z.array(z.string().max(200_000)).max(MAX_FIGURES_PER_FILE),
})

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'gdelt', limit: 120, windowSeconds: 60 })
  await requireGdeltToken(event)
  const body = await readValidatedBody(event, Body.parse)
  const now = new Date()
  const fetchedAt = Date.parse(body.fetched_at)
  if (Math.abs(now.getTime() - fetchedAt) > FETCHED_AT_SLACK_MS) {
    throw createError({ statusCode: 422, message: 'fetched_at is not close to now' })
  }
  const outcome = await recordFigureFile(
    db,
    blobRawStore(blob),
    { ...body, fetched_at: new Date(fetchedAt).toISOString() },
    now,
  )
  if (!outcome.recorded) {
    throw createError({ statusCode: 409, message: 'That file is not waiting for figures' })
  }
  return outcome
})
