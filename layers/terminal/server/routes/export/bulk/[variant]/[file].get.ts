// GET /export/bulk/<recent|full>/<table>.csv.gz — one bulk-feed file, as the
// manifest lists it (/export/bulk/manifest.json). `recent` is open to anyone;
// `full` needs a licensee's key. Served from R2 with no D1 read. The file's
// SHA-256 is its ETag, so a client that has it gets a 304.

import { blob } from '@nuxthub/blob'

import { cacheControlFor, rateLimitTerminal } from '../../../../utils/api-access'
import { SCHEMA_VERSION_HEADER } from '../../../../utils/data-schema'
import { bulkFileOf, bulkPath, notModified, readBulkIndex } from '../../../../utils/terminal-bulk'

export default defineEventHandler(async (event) => {
  const key = await rateLimitTerminal(event, { name: 'bulk-file', limit: 60, windowSeconds: 60 })
  const variant = getRouterParam(event, 'variant')
  if (variant === 'full' && !key) {
    setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
    throw createError({
      statusCode: 401,
      message:
        'The full-history bulk files need an API key (see /data#institutions). Without one, /export/<table>.csv?history=full serves every row under CC BY-NC 4.0.',
    })
  }

  const file = bulkFileOf(await readBulkIndex(blob), variant, getRouterParam(event, 'file'))
  if (!file) throw createError({ statusCode: 404, message: 'No bulk file at that path' })

  const etag = `"${file.sha256}"`
  setResponseHeaders(event, {
    ETag: etag,
    'Last-Modified': new Date(file.generated_at).toUTCString(),
    'Cache-Control': cacheControlFor(
      event,
      file.variant === 'full' ? 'private, max-age=3600' : 'public, max-age=3600',
    ),
    [SCHEMA_VERSION_HEADER]: file.schema_version,
    'X-Content-SHA256': file.sha256,
    'X-License': file.license ?? 'per row, in the license column',
  })
  if (
    notModified(
      getRequestHeader(event, 'if-none-match'),
      getRequestHeader(event, 'if-modified-since'),
      etag,
      file.generated_at,
    )
  ) {
    setResponseStatus(event, 304)
    return null
  }

  const body = await blob.get(bulkPath(file.variant, file.table))
  if (!body) throw createError({ statusCode: 404, message: 'No bulk file at that path' })
  setResponseHeaders(event, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${file.table}.${file.variant}.csv.gz"`,
  })
  return sendStream(event, body.stream())
})
