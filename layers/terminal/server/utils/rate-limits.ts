// The terminal's rate-limit budgets: the second native binding it declares, and
// the named numbers its permalink routes spend. Core (server/utils/rate-limit.ts)
// owns the mechanism; this is the product's side of it, registered from
// layers/terminal/server/plugins/rate-limits.ts.

import type { NativeLimiterSpec } from '#server/utils/rate-limit'

import { REQUEST_BUDGETS } from '../../shared/utils/institutional'

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

/**
 * Licensee keys (layers/terminal/server/utils/api-access.ts). A keyed request
 * is counted per key instead of per IP, against its tier's budget, on its own
 * native binding: at ten or twenty requests a second, a KV counter would
 * overrun KV's one-write-a-second-per-key limit and count nothing useful.
 * Each MUST match its `[[ratelimits]]` block in wrangler.toml, which
 * layers/terminal/test/rate-limits.test.ts probes.
 *
 *   research    600/60s on every /api route and the bulk feed: ten a second,
 *               ten times the anonymous read budget.
 *   systematic  1,200/60s: twenty a second, for a client that syncs the API
 *               on a schedule.
 *
 * The native binding counts per Cloudflare location. A licensee's servers sit
 * in one place, so that's the budget they see.
 */
export const KEYED_READ_LIMITERS = {
  research: {
    binding: 'RATE_LIMITER_600',
    limit: REQUEST_BUDGETS.research.read,
    windowSeconds: 60,
  },
  systematic: {
    binding: 'RATE_LIMITER_1200',
    limit: REQUEST_BUDGETS.systematic.read,
    windowSeconds: 60,
  },
} as const satisfies Record<string, NativeLimiterSpec>

/**
 * A live `/export/<table>` reads the whole table from D1 on every request, so
 * a key gets twice the anonymous budget here, not twenty times: the bulk feed
 * (/export/bulk/manifest.json) is the way to take every table daily. 60/60s is
 * READ_PATH_LIMITER's pair, so it runs on that binding.
 */
export const KEYED_EXPORT_LIMIT = REQUEST_BUDGETS.research.export

/** /export/payloads/<snapshot>, systematic keys only: one R2 read each, on the 600/60s binding. */
export const PAYLOAD_LIMIT = REQUEST_BUDGETS.systematic.payload
