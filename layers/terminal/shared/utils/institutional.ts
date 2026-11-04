// What a licensee key changes, in one place for the server and for /data.
//
// The rate limits here are the numbers the server enforces
// (layers/terminal/server/utils/rate-limits.ts reads them), so the page that
// documents them can't drift from the limiter. The license a key labels older
// rows with is PAID_LICENSE in shared/utils/license.ts. Prices are not here:
// they're by email.

export type KeyTier = 'research' | 'systematic'

/** Requests a minute, per route, for each caller. */
export const REQUEST_BUDGETS = {
  anonymous: { read: 60, export: 30 },
  research: { read: 600, export: 60 },
  systematic: { read: 1_200, export: 60, payload: 600 },
} as const

export const TIER_LABELS: Readonly<Record<KeyTier, string>> = {
  research: 'Research',
  systematic: 'Systematic',
}

/** The header an anonymous client sends nothing in, and a licensee sends its key in. */
export const KEY_HEADER_EXAMPLE = 'Authorization: Bearer ftk_…'
