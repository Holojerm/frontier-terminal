import { getRequestHeaders, readRawBody, sendProxy } from 'h3'

import { forwardedIngestHeaders } from '../../utils/ingest-headers'

// PostHog reverse proxy. The client SDK is configured with `api_host: '/ingest'`,
// so events, flags, replay snapshots and the SDK's own lazy bundles are all fetched
// same-origin.
//
//   /ingest/static/<path>   → https://us-assets.i.posthog.com/static/<path>
//   /ingest/<anything else> → https://us.i.posthog.com/<anything else>
//
// Not rate limited, unlike the template's relay: the project token ships in the
// client bundle, so a limit here would not stop anyone posting to PostHog directly.
const PAYLOAD_METHODS = new Set(['PATCH', 'POST', 'PUT', 'DELETE'])

export default defineEventHandler(async (event) => {
  const path = (getRouterParam(event, 'path') ?? '').replace(/^\/+/, '')
  const search = getRequestURL(event).search

  const upstream = path.startsWith('static/')
    ? `https://us-assets.i.posthog.com/${path}${search}`
    : `https://us.i.posthog.com/${path}${search}`

  const headers = forwardedIngestHeaders(getRequestHeaders(event), { forwardClientIp: true })

  // `false` returns the raw Buffer, so compressed replay snapshots are forwarded
  // byte for byte.
  const rawBody = PAYLOAD_METHODS.has(event.method)
    ? await readRawBody(event, false).catch(() => undefined)
    : undefined
  const body = rawBody ? new Uint8Array(rawBody) : undefined

  return sendProxy(event, upstream, {
    headers,
    fetchOptions: { method: event.method, body, redirect: 'manual' },
  })
})
