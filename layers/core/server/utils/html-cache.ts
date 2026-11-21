// A stamp-keyed edge cache for rendered HTML. Not `routeRules: { swr }`:
// stale-while-revalidate would serve a page whose `as_of` says 13:00 with
// 12:30's numbers, so this cache has NO staleness window.
//
// Like the JSON payloads (layers/core/server/utils/terminal-cache.ts), the key
// holds the poll stamp: a poll moves the stamp, every key rotates, and the next
// request re-renders. The TTL is garbage collection only. Learning the stamp
// costs one D1 read (~90ms against ~900ms to render); `sharedTerminalStamp`
// makes it one per render.
//
// The HTML is safe to share: no accounts, cookies or personalisation, colour
// mode is client-side, and `layers/core/app/composables/useNow.ts` stays null
// through SSR. The one other input is the footer's `new Date().getFullYear()`,
// so the year is part of the key.

/** Garbage collection only. A poll rotates the key long before this matters. */
export const HTML_CACHE_TTL_SECONDS = 2400

/**
 * What a browser may do with a cached document: reuse it for a minute, like
 * the JSON routes (TERMINAL_CACHE_CONTROL in terminal-handler.ts). Safe with
 * the CSP, which is one static string per route with no nonce. No `s-maxage`:
 * the stamp-keyed entry is the shared cache. Only on a 200 document the cache
 * stores or serves.
 */
export const HTML_CLIENT_CACHE_CONTROL = 'public, max-age=60'

/**
 * Where the original response headers ride while the entry is cached. The
 * stored copy needs a long `Cache-Control` for the Cache API to keep it, which
 * must never reach a browser, so the real headers travel here and are
 * replayed on a hit.
 */
export const HEADER_SIDECAR = 'x-html-cache-headers'

/**
 * `hit` or `miss`, on every cacheable document. The cache fails open and
 * silently, so this header is the only outside sign it works; test/csp
 * asserts it.
 */
export const CACHE_STATUS = 'x-html-cache'

/**
 * The cache key for a path at a poll tick.
 *
 * A synthetic absolute URL because that is what the Cache API takes as a key;
 * the host is never resolved. `never-polled` mirrors terminalCacheKey, so an
 * empty database is an ordinary case rather than a special one.
 */
export function htmlCacheKey(path: string, stamp: string | null, year: number): string {
  return `https://html-cache.invalid/${year}/${stamp ?? 'never-polled'}${path}`
}

/**
 * Whether this request may be served from, or stored in, the cache. Query
 * strings are excluded, not keyed on: they are an open set an attacker could
 * walk to fill the cache, and no public page varies on one. Only a plain GET.
 */
export function isCacheableDocument(req: { method: string; path: string }): boolean {
  if (req.method !== 'GET') return false
  if (req.path.includes('?')) return false
  // Rendered by Nitro but not a public document, or dev-only.
  if (req.path.startsWith('/api/')) return false
  if (req.path.startsWith('/_')) return false
  if (req.path === '/design-system') return false
  // Confirm and unsubscribe links carry a token in the query (already excluded
  // above); the pages themselves are never stored either.
  if (req.path.startsWith('/subscribe/')) return false
  return true
}

/** A rendered response is only storable when it is a 200 HTML document. */
export function isStorableResponse(res: {
  statusCode?: number
  headers?: Record<string, string> | undefined
  body?: unknown
}): boolean {
  const status = res.statusCode ?? 200
  if (status !== 200) return false
  if (typeof res.body !== 'string' || res.body.length === 0) return false
  const type = headerValue(res.headers, 'content-type')
  return type !== undefined && type.includes('text/html')
}

/** Case-insensitive lookup: h3 does not normalise what a render handler sets. */
export function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v
  }
  return undefined
}
