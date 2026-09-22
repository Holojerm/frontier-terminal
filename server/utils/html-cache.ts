// A stamp-keyed edge cache for rendered HTML.
//
// ── Why this is not `routeRules: { swr }` ───────────────────────────────────
// Stale-while-revalidate serves a document up to its window behind the `as_of`
// stamp printed on that same document. On a site whose whole claim is that
// every datum carries its source and its fetch time, a page that says 13:00 and
// renders 12:30's numbers is not a cache hit, it is a wrong answer. So this
// cache carries NO staleness window at all.
//
// ── How it avoids one ──────────────────────────────────────────────────────
// The same construction server/utils/terminal-cache.ts already uses for the
// JSON payloads: the key contains the poll stamp. A poll writes a new
// source_runs row, the stamp moves, every key rotates, and the next request
// misses and re-renders. A reader cannot be served HTML from before the tick
// that HTML claims to reflect — not because a timer expired, but because the
// entry is unreachable by key. The TTL below is garbage collection, nothing
// else.
//
// The cost of that guarantee is one D1 read per page request, to learn the
// stamp before the key can be built. That is ~90ms against ~900ms to render,
// and `sharedTerminalStamp` collapses it to one read per render.
//
// ── What makes the HTML safe to share between readers ──────────────────────
// There are no accounts, no cookies and no personalisation, and colour mode is
// resolved on the client — `app/composables/useNow.ts` deliberately stays null
// through SSR so the server emits absolute timestamps rather than "3m ago".
// The render is therefore a pure function of (path, poll stamp). The one
// exception is the footer's `new Date().getFullYear()`, which is why the year
// is part of the key.

/** Garbage collection only. A poll rotates the key long before this matters. */
export const HTML_CACHE_TTL_SECONDS = 2400

/**
 * Where the original response headers ride while the entry is in the cache.
 *
 * The stored copy needs its own `Cache-Control` for the Cache API to keep it,
 * and that value must never reach a reader: `public, max-age=2400` on a
 * document is exactly the browser-side staleness this cache exists to avoid.
 * So the real headers travel in this sidecar and are replayed on a hit, while
 * the storage `Cache-Control` is dropped.
 */
export const HEADER_SIDECAR = 'x-html-cache-headers'

/**
 * `hit` or `miss`, on every cacheable document.
 *
 * Not decoration: this cache's failure mode is silence. A missing `caches`
 * binding, a Cache API that throws, a key that never repeats — all of them fail
 * open into a normal render, which looks exactly like working correctly except
 * slower. This header is how anyone tells the difference from outside, and it is
 * what test/csp asserts a hit against.
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
 * Whether this request may be served from, or stored in, the cache.
 *
 * Deliberately narrow. A query string is excluded rather than keyed on: it is
 * an open set an attacker can walk to fill the cache with near-identical
 * copies, and no public page here varies on one. Anything but a plain GET, and
 * anything that did not render as a 200 HTML document, is left alone — an
 * error page cached under a stamp would outlive the condition that caused it.
 */
export function isCacheableDocument(req: { method: string; path: string }): boolean {
  if (req.method !== 'GET') return false
  if (req.path.includes('?')) return false
  // Rendered by Nitro but not a public document, or dev-only.
  if (req.path.startsWith('/api/')) return false
  if (req.path.startsWith('/_')) return false
  if (req.path === '/design-system') return false
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

/** Case-insensitive lookup — h3 does not normalise what a render handler sets. */
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
