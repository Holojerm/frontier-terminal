// POST /api/gdelt/file — one GDELT GKG file the Actions job read, for a file
// /api/gdelt/work handed out: how many rows it held and the rows that matched
// an alert, verbatim. The Worker parses and matches each row again before it
// keeps it (recordGkgFile). 409 for a file that is not due or already read.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { z } from 'zod'

import { blobRawStore } from '../../pipeline/poll'
import { recordGkgFile } from '../../pipeline/track-record/search'
import { requireGdeltToken } from '../../utils/gdelt-auth'

/** A fetch time this far off the Worker's clock is refused: the job posts each file at once. */
const FETCHED_AT_SLACK_MS = 15 * 60_000

/** Matched rows one file may post. A real file matches a handful; this bounds a runaway term. */
export const MAX_MATCHES_PER_FILE = 200

const Body = z.object({
  stamp: z.string().regex(/^\d{14}$/),
  fetched_at: z.string().datetime(),
  status: z.enum(['ok', 'missing']),
  rows: z.number().int().min(0).max(1_000_000),
  matches: z
    .array(
      z.object({
        alert_id: z.string().regex(/^[0-9a-f]{64}$/),
        // A GKG row is ~5–60 KB, almost all of it GDELT's content-analysis scores.
        row: z.string().max(200_000),
      }),
    )
    .max(MAX_MATCHES_PER_FILE),
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
    blobRawStore(blob),
    { ...body, fetched_at: new Date(fetchedAt).toISOString() },
    now,
  )
  if (!outcome.recorded) {
    throw createError({ statusCode: 409, message: 'That file is not due, or was already read' })
  }
  return outcome
})
