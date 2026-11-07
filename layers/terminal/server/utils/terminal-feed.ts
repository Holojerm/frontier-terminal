// The Atom feed of alerts (RFC 4287), as a pure function of plain data so
// layers/terminal/test/terminal-feed.test.ts can assert on the document without booting a
// Worker. layers/terminal/server/routes/alerts.xml.get.ts is the thin wrapper.
//
// Why Atom and not RSS: Atom requires a timestamp with a timezone on every
// entry and an id that is a URI — both are things this project already
// insists on for every datum, so the format's strictness costs nothing and
// buys a feed reader that cannot misfile an alert.

import { escapeXml, normalizeOrigin } from '#shared/utils/site'
import { alertPath, CRITICAL_FEED_QUERY, INFO_FEED_QUERY } from '../../shared/utils/terminal-tiers'
import type { AlertView } from '../../shared/utils/terminal-types'

/** `alert` is the default feed; `all` adds the minor changes; `critical` keeps only critical alerts. */
export type FeedTier = 'alert' | 'critical' | 'all'

export interface AlertsFeedInput {
  appName: string
  /** Canonical origin. Empty is allowed: ids fall back to URNs and links stay relative. */
  appUrl: string
  /** Newest first, as /api/alerts serves them, already filtered to `tier`. */
  alerts: readonly AlertView[]
  tier?: FeedTier
  /** `updated` for the feed itself when there are no entries (RFC 4287 requires one). */
  fallbackUpdated: string
}

export const ALERTS_FEED_PATH = '/alerts.xml'

/** Each document is its own feed, with its own self link. */
export function feedPath(tier: FeedTier): string {
  if (tier === 'all') return `${ALERTS_FEED_PATH}?${INFO_FEED_QUERY}`
  if (tier === 'critical') return `${ALERTS_FEED_PATH}?${CRITICAL_FEED_QUERY}`
  return ALERTS_FEED_PATH
}

/**
 * The feed's Atom id. An id is permanent (RFC 4287 §4.2.6) and a reader
 * dedupes on it, so the every-severity feed keeps the id it had when its
 * query flag was `include=ticker`, while its self link moved to `include=info`.
 */
export function feedIdPath(tier: FeedTier): string {
  return tier === 'all' ? `${ALERTS_FEED_PATH}?include=ticker` : feedPath(tier)
}

/** An Atom id must be an IRI. The alert's permalink when there is an origin, a URN otherwise. */
export function alertEntryId(appUrl: string, alertId: string): string {
  const origin = normalizeOrigin(appUrl)
  return origin ? `${origin}${alertPath(alertId)}` : `urn:sha256:${alertId}`
}

const SUBTITLE = {
  alert:
    'Notable and critical alerts on what changed, raised by the judge or by a fixed rule. Each entry links to the page we read it from.',
  critical:
    'Critical alerts only: the changes to look at today. Each entry links to the page we read it from.',
  all: 'Every alert and minor change, at every severity. Each entry links to the page we read it from.',
} as const satisfies Record<FeedTier, string>

const TITLE = {
  alert: 'alerts',
  critical: 'critical alerts',
  all: 'alerts and minor changes',
} as const satisfies Record<FeedTier, string>

/** The URN suffix when there is no origin; the default feed has none. */
const URN_SUFFIX = {
  alert: '',
  critical: ':critical',
  all: ':with-ticker',
} as const satisfies Record<FeedTier, string>

export function buildAlertsAtom(input: AlertsFeedInput): string {
  const tier = input.tier ?? 'alert'
  const origin = normalizeOrigin(input.appUrl)
  const feedId = origin
    ? `${origin}${feedIdPath(tier)}`
    : `urn:frontier-terminal:alerts${URN_SUFFIX[tier]}`
  const selfHref = origin ? `${origin}${feedPath(tier)}` : feedId
  const site = origin || ''
  const updated = input.alerts[0]?.created_at ?? input.fallbackUpdated

  const entries = input.alerts.map((alert) => {
    const alternate = `${site}${alertPath(alert.id)}`
    const lines = [
      '  <entry>',
      `    <id>${escapeXml(alertEntryId(input.appUrl, alert.id))}</id>`,
      `    <title>${escapeXml(alert.headline)}</title>`,
      `    <updated>${escapeXml(alert.created_at)}</updated>`,
      `    <published>${escapeXml(alert.created_at)}</published>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(alternate)}"/>`,
      // The source the cited change was read from — the provenance rule, in feed form.
      `    <link rel="related" href="${escapeXml(alert.source_url)}" title="${escapeXml(`source, fetched ${alert.fetched_at}`)}"/>`,
      `    <category term="${escapeXml(alert.severity)}" label="severity"/>`,
      `    <category term="${escapeXml(alert.rule)}" label="rule"/>`,
      `    <summary type="text">${escapeXml(alert.explanation)}</summary>`,
      '  </entry>',
    ]
    return lines.join('\n')
  })

  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(feedId)}</id>`,
    `  <title>${escapeXml(`${input.appName} ${TITLE[tier]}`)}</title>`,
    `  <subtitle>${escapeXml(SUBTITLE[tier])}</subtitle>`,
    `  <updated>${escapeXml(updated)}</updated>`,
    `  <author><name>${escapeXml(input.appName)}</name></author>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(selfHref)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(`${site}/alerts`)}"/>`,
  ]

  return [...head, ...entries, '</feed>', ''].join('\n')
}
