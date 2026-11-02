// The terminal's rate-limit budgets: the second native binding it declares, and
// the named numbers its permalink routes spend. Core (server/utils/rate-limit.ts)
// owns the mechanism; this is the product's side of it, registered from
// layers/terminal/server/plugins/rate-limits.ts.

import type { NativeLimiterSpec } from '#server/utils/rate-limit'

/**
 * The public read path: every /api/* route the terminal's pages fetch asks for
 * 60/60s. Core's own RATE_LIMITER (30/60s) carries the two writers, export and
 * judge; this is the `[[ratelimits]]` block named RATE_LIMITER_60 in
 * wrangler.toml, and it MUST match that block's numbers —
 * layers/terminal/test/rate-limits.test.ts probes the real binding and fails if
 * they drift, because a mismatch does not throw, it just quietly stops anything
 * from using the native path.
 */
export const READ_PATH_LIMITER: NativeLimiterSpec = {
  binding: 'RATE_LIMITER_60',
  limit: 60,
  windowSeconds: 60,
}

/**
 * The budget for a permalink family — `/api/alerts/:id`, `/api/prices/:key`.
 *
 * Sized off the sitemap rather than off a feeling. robots.txt invites fifteen
 * crawlers onto every public page, and server/routes/sitemap.xml.get.ts
 * enumerates one URL per SKU and one per alert — 378 and 184 when this was
 * written, both growing with the store. A budget smaller than a full family
 * means every crawl half-completes, and what the crawler gets for the rest is
 * an error where the most citable documents on this site should be. So the
 * number has to clear a whole pass inside one window, with room to grow.
 *
 * It is still a ceiling, not a formality: 500/60s is eight requests a second
 * sustained, which no reader and no crawler comes near and a scraping loop
 * passes in a blink. Both routes answer from the KV cache behind an edge
 * cache (TERMINAL_CACHE_CONTROL), so a hit that reaches this is already the
 * cheap kind.
 */
export const PERMALINK_LIMIT = 500
