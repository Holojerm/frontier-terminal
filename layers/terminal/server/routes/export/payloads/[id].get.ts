// GET /export/payloads/<snapshot id> — the saved copy of the page a snapshot
// read, byte for byte, for a systematic API key. The id is a snapshots.id
// (`<source_id>:<fetched_at>`) from /export/snapshots, URL-encoded or not.
//
// 401 without a key, 403 for a research key or a source that isn't ours to
// license (layers/terminal/server/utils/terminal-payloads.ts), 404 for an id
// we never stored. A snapshot never changes, so its content hash is the ETag
// and a client that already has it gets a 304.

import { blob } from '@nuxthub/blob'

import sourcesYaml from 'raw:~~/sources.yaml'

import { rateLimit } from '#server/utils/rate-limit'

import { requireApiKeyTier } from '../../../utils/api-access'
import { PAYLOAD_LIMIT } from '../../../utils/rate-limits'
import { terminalDb } from '../../../utils/terminal-handler'
import {
  isSnapshotId,
  payloadRefusal,
  snapshotById,
  sourceRights,
} from '../../../utils/terminal-payloads'
import { readSourceRegistry } from '../../../utils/terminal-sources'

let registry: ReturnType<typeof readSourceRegistry> | undefined

export default defineEventHandler(async (event) => {
  const key = await requireApiKeyTier(event, 'systematic')
  await rateLimit(event, {
    name: 'payload',
    limit: PAYLOAD_LIMIT,
    windowSeconds: 60,
    identifier: `key:${key.id}`,
  })

  const id = decodeURIComponent(getRouterParam(event, 'id') ?? '')
  if (!isSnapshotId(id)) {
    throw createError({
      statusCode: 400,
      message: 'Not a snapshot id. Take one from the id column of /export/snapshots.',
    })
  }
  const snapshot = await snapshotById(terminalDb, id)
  if (!snapshot) throw createError({ statusCode: 404, message: 'No snapshot with that id' })

  registry ??= readSourceRegistry(sourcesYaml)
  const refusal = payloadRefusal(sourceRights(registry, snapshot.source_id))
  if (refusal) throw createError({ statusCode: 403, message: refusal })

  const etag = `"${snapshot.content_hash}"`
  setResponseHeaders(event, {
    ETag: etag,
    'Cache-Control': 'private, max-age=86400, immutable',
    'X-Source-Url': snapshot.source_url,
    'X-Fetched-At': snapshot.fetched_at,
  })
  if (getRequestHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return null
  }

  const body = await blob.get(snapshot.raw_key)
  if (!body) {
    throw createError({ statusCode: 404, message: 'The saved copy of this page is missing' })
  }
  setResponseHeaders(event, {
    'Content-Type': body.type || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${snapshot.raw_key.split('/').pop()}"`,
  })
  return sendStream(event, body.stream())
})
