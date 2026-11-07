// POST /api/gdelt/file — one GDELT GKG file the Actions job read, the next one
// /api/gdelt/work handed out: how many rows it held and the rows carrying a
// vocabulary word, compacted. The Worker keeps a row with only the names its
// own vocabulary holds (recordGkgFile); nothing is matched to an alert here.
// 409 for a file that is not the next one due.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { MAX_MENTIONS_PER_FILE } from '../../pipeline/track-record/mentions'
import { recordGkgFile } from '../../pipeline/track-record/search'
import { requireGdeltToken } from '../../utils/gdelt-auth'

/** A fetch time this far off the Worker's clock is refused: the job posts each file at once. */
const FETCHED_AT_SLACK_MS = 15 * 60_000

// Unknown keys are stripped, so a job from before this shape (it also sent
// `matches`) is read the same.
const Body = z.object({
  stamp: z.string().regex(/^\d{14}$/),
  fetched_at: z.string().datetime(),
  status: z.enum(['ok', 'missing']),
  rows: z.number().int().min(0).max(1_000_000),
  mentions: z
    .array(
      z.object({
        record_id: z.string().min(1).max(100),
        outlet: z.string().max(300),
        url: z.string().url().max(2_000),
        title: z.string().min(1).max(1_000),
        names: z.array(z.string().min(1).max(100)).min(1).max(50),
      }),
    )
    .max(MAX_MENTIONS_PER_FILE),
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
  const outcome = await recordGkgFile(
    db,
    { ...body, fetched_at: new Date(fetchedAt).toISOString() },
    now,
  )
  if (!outcome.recorded) {
    throw createError({ statusCode: 409, message: 'That file is not the next one due' })
  }
  return outcome
})
