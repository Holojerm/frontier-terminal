// POST /api/gdelt/figures — the figure headlines of one GKG file the press side
// read before reported figures existed, for a file /api/gdelt/work listed under
// `figure_files`, compacted like a mention. The Worker matches each headline
// again before it keeps it (recordFigureFile). 409 for a file that is not
// listed or already read.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { MAX_FIGURES_PER_FILE, recordFigureFile } from '../../pipeline/reported/store'
import { requireGdeltToken } from '../../utils/gdelt-auth'

/** A fetch time this far off the Worker's clock is refused: the job posts each file at once. */
const FETCHED_AT_SLACK_MS = 15 * 60_000

const Body = z.object({
  stamp: z.string().regex(/^\d{14}$/),
  fetched_at: z.string().datetime(),
  figures: z
    .array(
      z.object({
        record_id: z.string().min(1).max(100),
        outlet: z.string().max(300),
        url: z.string().url().max(2_000),
        title: z.string().min(1).max(1_000),
      }),
    )
    .max(MAX_FIGURES_PER_FILE),
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
    { ...body, fetched_at: new Date(fetchedAt).toISOString() },
    now,
  )
  if (!outcome.recorded) {
    throw createError({ statusCode: 409, message: 'That file is not waiting for figures' })
  }
  return outcome
})
