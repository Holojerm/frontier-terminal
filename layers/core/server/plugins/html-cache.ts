// Wires the stamp-keyed HTML cache (layers/core/server/utils/html-cache.ts) into
// Nitro through two render-handler hooks: render:before serves a hit by setting
// ctx.response (Nitro skips the render), and render:response stores the body.
// They sit inside the render handler because Nitro applies the `routeRules`
// headers (CSP, HSTS, securityHeaders in nuxt.config.ts) in a later layer; a
// middleware that served hits would ship them with no Content-Security-Policy.
//
// FAILS OPEN: a missing `caches` binding, a Cache API throw or an unreachable D1
// falls through to a normal render. `caches` does not exist under Node, so
// `nuxt dev` shows no `x-html-cache` header; layers/core/test/html-cache-edge.test.ts
// covers the Cache API half in workerd.

import type { H3Event } from 'h3'

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

/** Adds this request's Server-Timing (see utils/server-timing.ts), with the whole render as `total`. */
function withServerTiming(response: RenderResponse, event: H3Event): void {
  const timings = event.context.serverTimings as ServerTiming[] | undefined
  const startedAt = event.context.renderStartedAt as number | undefined
  if (!timings || startedAt === undefined) return
  const total = { name: 'total', dur: Date.now() - startedAt }
  response.headers = {
    ...response.headers,
    'server-timing': serverTimingHeader([...timings, total]),
  }
}

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('render:before', async (ctx: { event: H3Event; response?: RenderResponse }) => {
    const cache = edgeCache()
    if (!cache) return
    const event = ctx.event
    if (!isCacheableDocument({ method: event.method, path: event.path })) return

    const timings: ServerTiming[] = []
    event.context.serverTimings = timings
    event.context.renderStartedAt = Date.now()

    try {
      // The same composite stamp the KV payloads key on, so a judge run
      // rotates the HTML too rather than waiting for the next poll.
      const stamp = await timed(timings, 'stamp', () =>
        sharedTerminalStamp(() => terminalStamps(db)),
      )
      // Keyed by build as well as poll, so a deploy never serves the last build's HTML.
      const build = useRuntimeConfig().public.buildSha || 'dev'
      const key = htmlCacheKey(`/${build}${event.path}`, stamp.key, new Date().getUTCFullYear())
      // Remembered so render:response stores under the key it missed on,
      // rather than re-reading a stamp that may have moved mid-render.
      event.context.htmlCacheKey = key

      const hit = await timed(timings, 'html-cache', () => cache.match(new Request(key)))
      timings.at(-1)!.desc = hit ? 'hit' : 'miss'
      if (!hit) return

      const sidecar = hit.headers.get(HEADER_SIDECAR)
      event.context.htmlCacheServed = true
      ctx.response = {
        body: await hit.text(),
        statusCode: 200,
        // The stored Cache-Control is storage policy and stops here: replaying
        // it would put the staleness back in the browser, where nothing rotates it.
        headers: {
          ...((sidecar ? JSON.parse(sidecar) : {}) as Record<string, string>),
          [CACHE_STATUS]: 'hit',
          'cache-control': HTML_CLIENT_CACHE_CONTROL,
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
    if (!key || ctx.event.context.htmlCacheServed) return withServerTiming(response, ctx.event)
    if (!isStorableResponse(response)) return

    const headers = response.headers ?? {}
    // Says which path served this. A cache whose hit rate cannot be observed is
    // a cache nobody notices has stopped working.
    response.headers = { ...headers, [CACHE_STATUS]: 'miss' }
    // After `headers` is captured for the sidecar: a stored timing would be
    // replayed on every later hit as if it described that request.
    withServerTiming(response, ctx.event)
    // Not in the sidecar above: the stored copy has its own storage policy.
    response.headers = { ...response.headers, 'cache-control': HTML_CLIENT_CACHE_CONTROL }

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
