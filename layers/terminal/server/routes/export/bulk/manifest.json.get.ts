// GET /export/bulk/manifest.json — the bulk feed's index: per table, the URL
// of its gzipped CSV and of its Parquet file, rows, bytes, SHA-256, build
// time, schema version, and license. Anonymous callers are listed the
// trailing-window files (CC BY 4.0); a licensee's key is listed the
// full-history files, with their keys in the licensed S3 bucket. The files are rebuilt
// once a UTC day (layers/terminal/server/utils/terminal-bulk.ts).
//
// Sync by comparing each entry's sha256 with the copy you have. The manifest
// itself answers If-None-Match and If-Modified-Since with a 304.

import { blob } from '@nuxthub/blob'

import { sha256Hex } from '#server/utils/hash'

import { cacheControlFor, rateLimitTerminal } from '../../../utils/api-access'
import { SCHEMA_VERSION, SCHEMA_VERSION_HEADER } from '../../../utils/data-schema'
import { bulkManifest, notModified, readBulkIndex } from '../../../utils/terminal-bulk'

export default defineEventHandler(async (event) => {
  const key = await rateLimitTerminal(event, { name: 'bulk', limit: 60, windowSeconds: 60 })
  const index = await readBulkIndex(blob)
  if (Object.keys(index.files).length === 0) {
    setResponseHeader(event, 'Retry-After', 3600)
    throw createError({
      statusCode: 503,
      message: 'The bulk feed hasn’t been built yet. It’s rebuilt hourly at :41 UTC.',
    })
  }
  const appUrl = useRuntimeConfig(event).public.appUrl.replace(/\/+$/, '')
  const manifest = bulkManifest(index, key ? 'full' : 'recent', appUrl)

  const etag = `"${await sha256Hex(JSON.stringify(manifest))}"`
  setResponseHeaders(event, {
    ETag: etag,
    'Cache-Control': cacheControlFor(event, 'public, max-age=300'),
    // A key is listed different files at the same URL.
    Vary: 'Authorization',
    [SCHEMA_VERSION_HEADER]: SCHEMA_VERSION,
    ...(manifest.generated_at
      ? { 'Last-Modified': new Date(manifest.generated_at).toUTCString() }
      : {}),
  })
  if (
    notModified(
      getRequestHeader(event, 'if-none-match'),
      getRequestHeader(event, 'if-modified-since'),
      etag,
      manifest.generated_at,
    )
  ) {
    setResponseStatus(event, 304)
    return null
  }
  return manifest
})
