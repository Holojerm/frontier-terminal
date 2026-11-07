// Minor changes versus alerts: the one materiality split every surface agrees on.
//
// The severity enum (layers/terminal/server/pipeline/contracts/rows.ts › severityEnum) is the
// stored datum; the tier is a reading of it. `info` is the minor-changes tier — what
// moved, low stakes: a role added, a title reworded, a location shuffled.
// It was called the ticker until 2026-11-04; a fund reads a `ticker` field as a
// security symbol, so no public surface uses the word for it now, and the old
// `ticker` value is accepted as an alias wherever a URL could carry it.
// `notable` and `critical` are alerts — what an analyst should read: a price
// move, a new SKU, a department-level hiring shift, a filing. One function so
// the landing band, /alerts, the Atom feed and the sitemap cannot drift.

export type AlertSeverity = 'info' | 'notable' | 'critical'
export type AlertTier = 'alert' | 'info'

/**
 * What a reader can ask for: one tier, everything, or `critical`, the slice of
 * the alert tier to read today. `critical` narrows a tier rather than being
 * one, so the two-way split above stays the only materiality line.
 */
export const ALERT_TIER_FILTERS = ['alert', 'critical', 'info', 'all'] as const
export type AlertTierFilter = (typeof ALERT_TIER_FILTERS)[number]

const TIER_OF: Readonly<Record<AlertSeverity, AlertTier>> = {
  info: 'info',
  notable: 'alert',
  critical: 'alert',
}

export function alertTier(severity: AlertSeverity): AlertTier {
  return TIER_OF[severity]
}

/** The severities a filter admits; `all` is every severity. */
export function severitiesOf(filter: AlertTierFilter): AlertSeverity[] {
  const all = Object.keys(TIER_OF) as AlertSeverity[]
  if (filter === 'all') return all
  if (filter === 'critical') return ['critical']
  return all.filter((s) => TIER_OF[s] === filter)
}

/** The permalink of one alert, root-relative. */
export function alertPath(id: string): string {
  return `/alerts/${id}`
}

/**
 * A tier filter as a request spells it: `ticker` is the pre-2026-11-04 name
 * of `info`, kept so a saved URL or a client built against it still works.
 */
export function tierFilterOf(value: unknown): unknown {
  return value === 'ticker' ? 'info' : value
}

/** The Atom feed carries alerts by default; this query flag adds the minor changes. */
export const INFO_FEED_QUERY = 'include=info'

/** The Atom feed narrowed to critical alerts; the same spelling /api/alerts and /alerts take. */
export const CRITICAL_FEED_QUERY = 'tier=critical'

/** What the minor-changes tier is called wherever a reader sees it. */
export const INFO_TIER_LABEL = 'Minor changes'
