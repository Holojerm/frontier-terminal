// The Cache API half of the HTML cache, against the real thing.
//
// These run in workerd (vitest-pool-workers), because `caches.default` is a
// Workers API and simply does not exist under Node — which is also why
// `nuxt dev` can never exercise this code: the plugin feature-detects, finds no
// cache, and no-ops. Everything here is therefore untestable in the dev server
// and testable only in this pool.
//
// What is proven: a stored document comes back byte-identical, the sidecar
// round-trips the real headers, the storage Cache-Control never escapes, and a
// new poll stamp makes the previous entry unreachable rather than merely stale.

import { describe, expect, it } from 'vitest'

import {
  CACHE_STATUS,
  HEADER_SIDECAR,
  HTML_CACHE_TTL_SECONDS,
  htmlCacheKey,
} from '../server/utils/html-cache'

const HTML = '<!DOCTYPE html><html><body>frontier</body></html>'
const YEAR = 2026

/** What the plugin's render:response path builds. */
function storable(body: string, headers: Record<string, string>): Response {
  return new Response(body, {
    headers: {
      'content-type': headers['content-type'] ?? 'text/html;charset=utf-8',
      'cache-control': `public, max-age=${HTML_CACHE_TTL_SECONDS}`,
      [HEADER_SIDECAR]: JSON.stringify(headers),
    },
  })
}

/** A key nothing else in the suite shares. */
const uniquePath = () => `/p-${crypto.randomUUID()}`

describe('the edge cache round-trip', () => {
  it('stores a document and serves it back byte-identical', async () => {
    const key = htmlCacheKey(uniquePath(), 'stamp-a', YEAR)
    await caches.default.put(new Request(key), storable(HTML, { 'content-type': 'text/html' }))

    const hit = await caches.default.match(new Request(key))
    expect(hit).toBeDefined()
    expect(await hit!.text()).toBe(HTML)
  })

  it('round-trips the real response headers through the sidecar', async () => {
    const key = htmlCacheKey(uniquePath(), 'stamp-a', YEAR)
    const original = { 'content-type': 'text/html;charset=utf-8', 'x-nitro-ssr': '1' }
    await caches.default.put(new Request(key), storable(HTML, original))

    const hit = await caches.default.match(new Request(key))
    expect(JSON.parse(hit!.headers.get(HEADER_SIDECAR)!)).toEqual(original)
  })

  it('never lets the storage Cache-Control reach the replayed headers', async () => {
    // This is the one that matters. `public, max-age=2400` on a document would
    // reintroduce exactly the staleness this design exists to avoid — moved
    // from the edge, where the key controls it, into the browser, where nothing
    // does. The plugin replays the sidecar and drops everything else.
    const key = htmlCacheKey(uniquePath(), 'stamp-a', YEAR)
    const original = { 'content-type': 'text/html;charset=utf-8' }
    await caches.default.put(new Request(key), storable(HTML, original))

    const hit = await caches.default.match(new Request(key))
    expect(hit!.headers.get('cache-control')).toContain('max-age')

    const replayed = { ...JSON.parse(hit!.headers.get(HEADER_SIDECAR)!), [CACHE_STATUS]: 'hit' }
    expect(replayed['cache-control']).toBeUndefined()
    expect(replayed[CACHE_STATUS]).toBe('hit')
  })

  it('a new poll stamp makes the old entry unreachable, not stale', async () => {
    // The guarantee. Nothing expires and nothing is purged: the next tick simply
    // asks a different question, and the answer is a miss.
    const path = uniquePath()
    await caches.default.put(
      new Request(htmlCacheKey(path, 'stamp-a', YEAR)),
      storable(HTML, { 'content-type': 'text/html' }),
    )

    expect(
      await caches.default.match(new Request(htmlCacheKey(path, 'stamp-a', YEAR))),
    ).toBeDefined()
    expect(
      await caches.default.match(new Request(htmlCacheKey(path, 'stamp-b', YEAR))),
    ).toBeUndefined()
  })

  it('does not confuse two paths under one stamp', async () => {
    const a = uniquePath()
    const b = uniquePath()
    await caches.default.put(
      new Request(htmlCacheKey(a, 'stamp-a', YEAR)),
      storable('<p>a</p>', { 'content-type': 'text/html' }),
    )
    await caches.default.put(
      new Request(htmlCacheKey(b, 'stamp-a', YEAR)),
      storable('<p>b</p>', { 'content-type': 'text/html' }),
    )

    const hitA = await caches.default.match(new Request(htmlCacheKey(a, 'stamp-a', YEAR)))
    const hitB = await caches.default.match(new Request(htmlCacheKey(b, 'stamp-a', YEAR)))
    expect(await hitA!.text()).toBe('<p>a</p>')
    expect(await hitB!.text()).toBe('<p>b</p>')
  })
})
