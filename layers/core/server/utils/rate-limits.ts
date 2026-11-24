// The terminal's rate-limit budgets. Core (server/utils/rate-limit.ts) owns the
// mechanism; these are registered from layers/core/server/plugins/rate-limits.ts.

/**
 * The public read path: 60/60s for every /api/* route the pages fetch (core's
 * RATE_LIMITER, 30/60s, carries the export and judge writers). This is the
 * `[[ratelimits]]` block RATE_LIMITER_60 in wrangler.toml and MUST match its
 * numbers: a mismatch doesn't throw, it silently stops the native path.
 * layers/core/test/rate-limits.test.ts probes the real binding.
 */
export const READ_PATH_LIMITER: NativeLimiterSpec = {
  binding: 'RATE_LIMITER_60',
  limit: 60,
  windowSeconds: 60,
}

/**
 * The budget for a permalink family (`/api/alerts/:id`, `/api/prices/:key`).
 *
 * Sized off the sitemap: robots.txt invites crawlers onto every public page, and
 * server/routes/sitemap.xml.get.ts lists one URL per SKU and one per alert,
 * hundreds each and growing. A smaller budget means every crawl half-completes
 * and gets errors on the most citable pages, so it must clear a whole pass in
 * one window, with room to grow.
 *
 * It is still a ceiling: 500/60s is about eight requests a second sustained,
 * which a scraping loop passes quickly. Both routes answer from the KV cache
 * behind an edge cache (TERMINAL_CACHE_CONTROL), so a hit that reaches this is
 * cheap.
 */
export const PERMALINK_LIMIT = 500

/**
 * Server renders of a page per IP: HTML cache misses only (plugins/html-cache.ts),
 * since a hit costs one stamp read and a cold render a dozen D1 reads plus the
 * page's /api calls.
 *
 * The /api budgets above cannot carry this. They run `exact: false` on a native
 * binding that counts per machine, and a scraper on fresh connections is never
 * stopped by it: on 2026-11-22 one IP cold-rendered pages at about 4 a second
 * across two colos and drove D1 into "overloaded" for a minute, failing every
 * reader's page. So this one is the exact D1 count, one upsert per cold render.
 *
 * 120 clears a whole sitemap pass (89 URLs on 2026-11-23) in one window, with
 * room to grow, and holds one IP to two cold renders a second.
 */
export const COLD_RENDER_LIMITER = { name: 'cold-render', limit: 120, windowSeconds: 60 } as const

/**
 * Licensee keys (layers/core/server/utils/api-access.ts), counted per key on
 * their tier's own native binding: at ten or twenty requests a second, a KV
 * counter would overrun KV's one-write-a-second-per-key limit. Each MUST match
 * its `[[ratelimits]]` block in wrangler.toml (layers/core/test/rate-limits.test.ts
 * probes them).
 *
 *   research    600/60s on every /api route and the bulk feed.
 *   systematic  1,200/60s, for a client that syncs the API on a schedule.
 *
 * The native binding counts per Cloudflare location; a licensee's servers sit in
 * one place, so that is the budget they see.
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
 * A live `/export/<table>` reads the whole table from D1, so a key gets only
 * twice the anonymous budget here; the bulk feed (/export/bulk/manifest.json) is
 * for taking every table daily. 60/60s pairs with READ_PATH_LIMITER, so it runs
 * on that binding.
 */
export const KEYED_EXPORT_LIMIT = REQUEST_BUDGETS.research.export

/** /export/payloads/<snapshot>, systematic keys only: one R2 read each, on the 600/60s binding. */
export const PAYLOAD_LIMIT = REQUEST_BUDGETS.systematic.payload
