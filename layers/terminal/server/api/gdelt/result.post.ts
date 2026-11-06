// POST /api/gdelt/result — one GDELT answer the GitHub Actions job fetched
// for a search /api/gdelt/pending handed out. Stored as the Worker's own
// fetch stored it: the search row, the bytes in R2, the articles as press
// candidates (recordGdeltResult). 409 for a search that is not due or a URL
// other than the one handed out.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { z } from 'zod'

import { blobRawStore } from '../../pipeline/poll'
import { recordGdeltResult } from '../../pipeline/track-record/search'
import { requireGdeltToken } from '../../utils/gdelt-auth'

/** A fetch time this far off the Worker's clock is refused: the job posts each answer at once. */
const FETCHED_AT_SLACK_MS = 15 * 60_000

const Body = z.object({
  alert_id: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.string().url().max(4000),
  fetched_at: z.string().datetime(),
  answer: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('http'),
      status: z.number().int().min(100).max(599),
      // GDELT's artlist answer for 75 articles is ~40 KB.
      text: z.string().max(2_000_000),
    }),
    z.object({ kind: z.literal('timeout') }),
    z.object({ kind: z.literal('error'), message: z.string().max(500) }),
  ]),
})

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'gdelt', limit: 30, windowSeconds: 60 })
  await requireGdeltToken(event)
  const body = await readValidatedBody(event, Body.parse)
  const now = new Date()
  const fetchedAt = Date.parse(body.fetched_at)
  if (Math.abs(now.getTime() - fetchedAt) > FETCHED_AT_SLACK_MS) {
    throw createError({ statusCode: 422, message: 'fetched_at is not close to now' })
  }
  const outcome = await recordGdeltResult(
    db,
    blobRawStore(blob),
    { ...body, fetched_at: new Date(fetchedAt).toISOString() },
    now,
  )
  if (!outcome.recorded) {
    throw createError({
      statusCode: 409,
      message:
        outcome.reason === 'not-due'
          ? 'That alert has no GDELT search due'
          : 'That is not the URL /api/gdelt/pending handed out',
    })
  }
  return outcome
})
