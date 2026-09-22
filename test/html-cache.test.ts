// The stamp-keyed HTML cache's decision rules.
//
// The guarantee under test is that the key, not a timer, is what makes a stale
// document unreachable — so the interesting cases are the ones that change the
// key, and the ones that must never be cached at all.

import { describe, expect, it } from 'vitest'

import {
  HEADER_SIDECAR,
  HTML_CACHE_TTL_SECONDS,
  headerValue,
  htmlCacheKey,
  isCacheableDocument,
  isStorableResponse,
} from '../server/utils/html-cache'

describe('htmlCacheKey', () => {
  it('changes when the poll stamp changes, which is the whole invalidation story', () => {
    const a = htmlCacheKey('/', '2026-09-22T10:00:00.000Z', 2026)
    const b = htmlCacheKey('/', '2026-09-22T10:30:00.000Z', 2026)
    expect(a).not.toBe(b)
  })

  it('separates paths, so /prices never serves /hiring', () => {
    const stamp = '2026-09-22T10:00:00.000Z'
    expect(htmlCacheKey('/prices', stamp, 2026)).not.toBe(htmlCacheKey('/hiring', stamp, 2026))
  })

  it('separates labs', () => {
    const stamp = '2026-09-22T10:00:00.000Z'
    expect(htmlCacheKey('/labs/openai', stamp, 2026)).not.toBe(
      htmlCacheKey('/labs/anthropic', stamp, 2026),
    )
  })

  it('includes the year, so the footer does not say last year after midnight on Jan 1', () => {
    // The one part of the render that is not a function of (path, stamp):
    // app/layouts/default.vue prints new Date().getFullYear().
    const stamp = '2026-12-31T23:59:00.000Z'
    expect(htmlCacheKey('/', stamp, 2026)).not.toBe(htmlCacheKey('/', stamp, 2027))
  })

  it('treats an unpolled database as an ordinary case, not an error', () => {
    expect(htmlCacheKey('/', null, 2026)).toContain('never-polled')
  })

  it('is a parseable absolute URL, because the Cache API keys on one', () => {
    expect(() => new URL(htmlCacheKey('/prices', 'x', 2026))).not.toThrow()
  })
})

describe('isCacheableDocument', () => {
  it('caches a plain GET of a public page', () => {
    expect(isCacheableDocument({ method: 'GET', path: '/' })).toBe(true)
    expect(isCacheableDocument({ method: 'GET', path: '/labs/openai' })).toBe(true)
  })

  it('never caches a non-GET', () => {
    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
      expect(isCacheableDocument({ method, path: '/' })).toBe(false)
    }
  })

  it('refuses a query string rather than keying on it', () => {
    // An open set an attacker can walk to fill the cache with near-identical
    // copies, and no public page here varies on one.
    expect(isCacheableDocument({ method: 'GET', path: '/prices?sort=asc' })).toBe(false)
  })

  it('leaves the API and the dev-only route alone', () => {
    expect(isCacheableDocument({ method: 'GET', path: '/api/prices' })).toBe(false)
    expect(isCacheableDocument({ method: 'GET', path: '/_nuxt/entry.js' })).toBe(false)
    expect(isCacheableDocument({ method: 'GET', path: '/design-system' })).toBe(false)
  })
})

describe('isStorableResponse', () => {
  const html = { 'content-type': 'text/html;charset=utf-8' }

  it('stores a 200 HTML document', () => {
    expect(isStorableResponse({ statusCode: 200, headers: html, body: '<html></html>' })).toBe(true)
  })

  it('never stores an error page', () => {
    // A 404 or 500 cached under a stamp would outlive the condition that caused
    // it — the stamp only moves on a poll, not on a fix.
    for (const statusCode of [404, 429, 500, 503]) {
      expect(isStorableResponse({ statusCode, headers: html, body: '<html></html>' })).toBe(false)
    }
  })

  it('never stores a non-HTML or empty body', () => {
    expect(
      isStorableResponse({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ).toBe(false)
    expect(isStorableResponse({ statusCode: 200, headers: html, body: '' })).toBe(false)
    expect(isStorableResponse({ statusCode: 200, headers: html, body: undefined })).toBe(false)
  })

  it('tolerates a header name in any case, since h3 does not normalise these', () => {
    expect(
      isStorableResponse({
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: '<p>',
      }),
    ).toBe(true)
  })
})

describe('headerValue', () => {
  it('is case-insensitive and safe on absent headers', () => {
    expect(headerValue({ 'Content-Type': 'text/html' }, 'content-type')).toBe('text/html')
    expect(headerValue(undefined, 'content-type')).toBeUndefined()
    expect(headerValue({}, 'content-type')).toBeUndefined()
  })
})

describe('the storage contract', () => {
  it('keeps entries long enough to outlast a poll window, since the key does the work', () => {
    // 30-minute poll cadence (wrangler.toml [triggers]); the TTL is garbage
    // collection, so it only has to exceed that.
    expect(HTML_CACHE_TTL_SECONDS).toBeGreaterThan(30 * 60)
  })

  it('names a sidecar header so the storage Cache-Control never reaches a reader', () => {
    // `public, max-age=...` on a document is precisely the browser-side
    // staleness this cache exists to avoid.
    expect(HEADER_SIDECAR).toMatch(/^x-/)
  })
})
