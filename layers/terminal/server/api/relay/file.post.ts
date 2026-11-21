// POST /api/relay/file?url=…&status=…&fetched_at=… — the bytes the Mac mini's
// relay job got for one URL on a relayed host, as the request body. The
// pipeline reads them in place of the network (core pipeline/relay.ts).

import { blob } from '@nuxthub/blob'
import { z } from 'zod'

import { isRelayed, putRelayCopy, RELAY_MAX_BYTES } from '#layers/core/server/pipeline/relay'
import { requireGdeltToken } from '../../utils/gdelt-auth'

/** The job posts each URL as soon as it has it. */
const FETCHED_AT_SLACK_MS = 15 * 60_000

const Query = z.object({
  url: z.string().url().max(2_000).refine(isRelayed, 'not a relayed host'),
  status: z.coerce.number().int().min(100).max(599),
  fetched_at: z.string().datetime(),
})

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'relay', limit: 60, windowSeconds: 60 })
  await requireGdeltToken(event)
  const query = await getValidatedQuery(event, Query.parse)
  const fetchedAt = Date.parse(query.fetched_at)
  if (Math.abs(Date.now() - fetchedAt) > FETCHED_AT_SLACK_MS) {
    throw createError({ statusCode: 422, message: 'fetched_at is not close to now' })
  }
  const raw = await readRawBody(event, false)
  const body = raw ? new Uint8Array(raw) : new Uint8Array(0)
  if (body.byteLength > RELAY_MAX_BYTES) {
    throw createError({ statusCode: 413, message: 'Body too large' })
  }
  await putRelayCopy(blob, {
    url: query.url,
    status: query.status,
    fetched_at: new Date(fetchedAt).toISOString(),
    body,
    contentType: getRequestHeader(event, 'content-type') ?? 'application/octet-stream',
  })
  return { stored: true, bytes: body.byteLength }
})
