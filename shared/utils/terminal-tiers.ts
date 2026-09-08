// Ticker versus alert: the one materiality split every surface agrees on.
//
// The severity enum (server/pipeline/contracts/rows.ts › severityEnum) is the
// stored datum; the tier is a reading of it. `info` is the ticker — what
// moved, low stakes: a role added, a title reworded, a location shuffled.
// `notable` and `critical` are alerts — what an analyst should read: a price
// move, a new SKU, a department-level hiring shift, a filing. One function so
// the landing band, /alerts, the Atom feed and the sitemap cannot drift.

export type AlertSeverity = 'info' | 'notable' | 'critical'
export type AlertTier = 'alert' | 'ticker'

/** What a reader can ask for: one tier, or everything. */
export const ALERT_TIER_FILTERS = ['alert', 'ticker', 'all'] as const
export type AlertTierFilter = (typeof ALERT_TIER_FILTERS)[number]

const TIER_OF: Readonly<Record<AlertSeverity, AlertTier>> = {
  info: 'ticker',
  notable: 'alert',
  critical: 'alert',
}

export function alertTier(severity: AlertSeverity): AlertTier {
  return TIER_OF[severity]
}

/** The severities a filter admits; `all` is every severity. */
export function severitiesOf(filter: AlertTierFilter): AlertSeverity[] {
  const all = Object.keys(TIER_OF) as AlertSeverity[]
  return filter === 'all' ? all : all.filter((s) => TIER_OF[s] === filter)
}

/** The permalink of one alert, root-relative. */
export function alertPath(id: string): string {
  return `/alerts/${id}`
}

/** The Atom feed carries alerts by default; this query flag adds the ticker. */
export const TICKER_FEED_QUERY = 'include=ticker'
