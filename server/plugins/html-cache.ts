// Wires the stamp-keyed HTML cache (server/utils/html-cache.ts) into Nitro.
//
// Two hooks on the render handler, which is the only place that sees a rendered
// document as a value rather than a stream:
//
//   render:before   — a hook that sets ctx.response makes Nitro skip the render
//                     entirely and serve what we handed it.
//   render:response — the rendered body, before it is sent, so we can store it.
//
// Both sit INSIDE the render handler on purpose. Nitro applies the `routeRules`
// headers — the CSP, HSTS and the rest of securityHeaders in nuxt.config.ts —
// in a separate layer that still runs on a cache hit. Serving the hit from a
// middleware that returned early would have skipped that layer and quietly
// shipped documents with no Content-Security-Policy.
//
// FAILS OPEN, like the rest of the caching here. No `caches` binding, a throw
// from the Cache API, an unreachable D1 — each falls through to a normal render.
// A cache is never allowed to be the reason a page does not load. This is also
// why `nuxt dev` shows no `x-html-cache` header at all: `caches` is a Workers
// API that does not exist under Node, so the feature-detect below finds nothing
// and the whole plugin no-ops. test/html-cache-edge.test.ts covers the Cache API
// half in workerd, where it does exist.

import { db } from '@nuxthub/db'
import type { H3Event } from 'h3'

import {
  CACHE_STATUS,
  HEADER_SIDECAR,
  HTML_CACHE_TTL_SECONDS,
  headerValue,
  htmlCacheKey,
  isCacheableDocument,
  isStorableResponse,
} from '../utils/html-cache'
import { sharedTerminalStamp, terminalStamp } from '../utils/terminal-cache'

interface RenderResponse {
  body?: unknown
  statusCode?: number
  statusMessage?: string
  headers?: Record<string, string>
}

/** The Cache API, or undefined off Cloudflare. A runtime detect, not a flag. */
function edgeCache(): Cache | undefined {
  const c = (globalThis as { caches?: { default?: Cache } }).caches
  return c && typeof c.default?.match === 'function' ? c.default : undefined
}

/** Cloudflare's waitUntil, so storing never delays the response. */
function waitUntil(event: H3Event, p: Promise<unknown>): void {
  const cf = event.context.cloudflare as
    | { context?: { waitUntil?: (p: Promise<unknown>) => void } }
    | undefined
  if (typeof cf?.context?.waitUntil === 'function') cf.context.waitUntil(p)
  else void p.catch(() => {})
}

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('render:before', async (ctx: { event: H3Event; response?: RenderResponse }) => {
    const cache = edgeCache()
    if (!cache) return
    const event = ctx.event
    if (!isCacheableDocument({ method: event.method, path: event.path })) return

    try {
      const stamp = await sharedTerminalStamp(() => terminalStamp(db))
      const key = htmlCacheKey(event.path, stamp, new Date().getUTCFullYear())
      // Remembered so render:response stores under the key it missed on,
      // rather than re-reading a stamp that may have moved mid-render.
      event.context.htmlCacheKey = key

      const hit = await cache.match(new Request(key))
      if (!hit) return

      const sidecar = hit.headers.get(HEADER_SIDECAR)
      event.context.htmlCacheServed = true
      ctx.response = {
        body: await hit.text(),
        statusCode: 200,
        // The stored Cache-Control is storage policy and stops here —
        // replaying it would put the staleness back, in the browser instead
        // of the edge, where nothing rotates it.
        headers: {
          ...((sidecar ? JSON.parse(sidecar) : {}) as Record<string, string>),
          [CACHE_STATUS]: 'hit',
        },
      }
    } catch (error) {
      console.warn(JSON.stringify({ kind: 'html_cache_read_failed', error: String(error) }))
    }
  })

  nitro.hooks.hook('render:response', (response: RenderResponse, ctx: { event: H3Event }) => {
    const cache = edgeCache()
    if (!cache) return
    const key = ctx.event.context.htmlCacheKey as string | undefined
    // Absent means render:before declined this path; htmlCacheServed means a hit
    // already answered it. Either way there is nothing new to store.
    if (!key || ctx.event.context.htmlCacheServed) return
    if (!isStorableResponse(response)) return

    const headers = response.headers ?? {}
    // Says which path served this. A cache whose hit rate cannot be observed is
    // a cache nobody notices has stopped working.
    response.headers = { ...headers, [CACHE_STATUS]: 'miss' }

    const stored = new Response(response.body as string, {
      headers: {
        'content-type': headerValue(headers, 'content-type') ?? 'text/html;charset=utf-8',
        'cache-control': `public, max-age=${HTML_CACHE_TTL_SECONDS}`,
        [HEADER_SIDECAR]: JSON.stringify(headers),
      },
    })
    waitUntil(
      ctx.event,
      cache.put(new Request(key), stored).catch((error: unknown) => {
        console.warn(JSON.stringify({ kind: 'html_cache_write_failed', error: String(error) }))
      }),
    )
  })
})
