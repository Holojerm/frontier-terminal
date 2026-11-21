// POST /api/gdelt/archive — the figure headlines of one GKG file from before
// GKG_FROM that /api/gdelt/work listed under `archive_files`, compacted like a
// mention. Figures only: no mention is kept, so no alert is matched against
// it (pipeline/reported/archive.ts). The Worker matches each headline again
// before it keeps it. 409 for a file outside the archive or already read.

import { z } from 'zod'

import { recordArchiveFile } from '../../pipeline/reported/archive'
import { MAX_FIGURES_PER_FILE } from '../../pipeline/reported/store'

/** A fetch time this far off the Worker's clock is refused: the job posts each file at once. */
const FETCHED_AT_SLACK_MS = 15 * 60_000

const Body = z.object({
  stamp: z.string().regex(/^\d{14}$/),
  fetched_at: z.string().datetime(),
  status: z.enum(['ok', 'missing']),
  rows: z.number().int().min(0).max(1_000_000),
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
  // Its own bucket: the job reads archive files four at a time, faster than the live ones.
  await rateLimit(event, { name: 'gdelt-archive', limit: 600, windowSeconds: 60 })
  await requireGdeltToken(event)
  const body = await readValidatedBody(event, Body.parse)
  const now = new Date()
  const fetchedAt = Date.parse(body.fetched_at)
  if (Math.abs(now.getTime() - fetchedAt) > FETCHED_AT_SLACK_MS) {
    throw createError({ statusCode: 422, message: 'fetched_at is not close to now' })
  }
  const outcome = await recordArchiveFile(
    db,
    { ...body, fetched_at: new Date(fetchedAt).toISOString() },
    now,
  )
  if (!outcome.recorded) {
    throw createError({ statusCode: 409, message: 'That file is not an unread archive file' })
  }
  return outcome
})
