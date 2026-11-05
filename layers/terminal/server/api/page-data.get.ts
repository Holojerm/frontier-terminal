// GET /api/page-data?path=/hiring — the data a page renders, without the page.
//
// The body is the page's own hydration payload (`__NUXT_DATA__`, devalue
// format), so a client-side navigation can hand it to Nuxt instead of
// starting every useFetch call at the click; the prefetch plugin
// (layers/terminal/app/plugins/page-prefetch.client.ts) is the reader. Every
// value in it is already in the page's HTML.
//
// The page is fetched in-process, so it is served by the stamp-keyed HTML
// cache when the document is there and rendered (and stored) when it is not:
// the payload is never older than the poll stamp, the same guarantee the
// document carries (layers/terminal/server/utils/html-cache.ts). Nuxt's own
// `/<path>/_payload.json` would need `cache`/`isr` route rules, which bring a
// time-based cache with them.

import { z } from 'zod'

import { CACHE_STATUS, isCacheableDocument } from '../utils/html-cache'
import { rateLimitTerminal } from '../utils/api-access'

const PAYLOAD_RE = /<script[^>]*\bid="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/

const querySchema = z.object({
  // A path, not a URL: no scheme, host, query or fragment, nothing to traverse.
  path: z
    .string()
    .max(200)
    .regex(/^\/[A-Za-z0-9\-._~:/]*$/),
})

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'page-data', limit: 60, windowSeconds: 60 })
  const { path } = await getValidatedQuery(event, querySchema.parse)
  if (!isCacheableDocument({ method: 'GET', path })) {
    throw createError({ statusCode: 400, statusMessage: 'Not a public page' })
  }

  // In-process (Nitro's local fetch), with this request's headers and context,
  // so the render spends the same visitor's budget a page load would.
  const page = await event.fetch(path, { headers: { accept: 'text/html' } })
  if (page.status !== 200) {
    throw createError({ statusCode: page.status === 404 ? 404 : 502 })
  }
  const payload = (await page.text()).match(PAYLOAD_RE)?.[1]
  if (!payload) throw createError({ statusCode: 502 })

  setResponseHeaders(event, {
    'content-type': 'application/json; charset=utf-8',
    // As fresh as the page it came from, and no fresher: the browser keeps nothing.
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
    [CACHE_STATUS]: page.headers.get(CACHE_STATUS) ?? 'none',
  })
  return payload
})
