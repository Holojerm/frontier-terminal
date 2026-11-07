// POST /api/gdelt/file — one GDELT GKG file the Actions job read, for a file
// /api/gdelt/work handed out: how many rows it held, the rows that matched
// an alert, verbatim, the rows that carry a vocabulary word, compacted, and
// the rows whose headline is a lab figure, verbatim. The Worker parses and
// matches each matched and figure row again before it keeps it, and keeps a
// mention only when every name it claims is in the vocabulary
// (recordGkgFile). 409 for a file that is not due or already read.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { z } from 'zod'

import { blobRawStore } from '../../pipeline/poll'
import { MAX_MENTIONS_PER_FILE } from '../../pipeline/track-record/mentions'
import { MAX_FIGURES_PER_FILE } from '../../pipeline/reported/store'
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
  // Every row carrying a vocabulary word, compacted, kept for alerts written
  // later (track-record/mentions.ts). Optional: a job from before them omits it.
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
    .max(MAX_MENTIONS_PER_FILE)
    .optional(),
  // Absent from a job checked out before reported figures existed.
  figures: z.array(z.string().max(200_000)).max(MAX_FIGURES_PER_FILE).default([]),
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
