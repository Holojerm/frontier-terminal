// The Atom feed of alerts (RFC 4287), as a pure function of plain data so
// test/terminal-feed.test.ts can assert on the document without booting a
// Worker. server/routes/alerts.xml.get.ts is the thin wrapper.
//
// Why Atom and not RSS: Atom requires a timestamp with a timezone on every
// entry and an id that is a URI — both are things this project already
// insists on for every datum, so the format's strictness costs nothing and
// buys a feed reader that cannot misfile an alert.

import { escapeXml, normalizeOrigin } from '#shared/utils/site'
import { alertPath, TICKER_FEED_QUERY } from '#shared/utils/terminal-tiers'
import type { AlertView } from '#shared/utils/terminal-types'

export interface AlertsFeedInput {
  appName: string
  /** Canonical origin. Empty is allowed: ids fall back to URNs and links stay relative. */
  appUrl: string
  /** Newest first, as /api/alerts serves them, already filtered to `tier`. */
  alerts: readonly AlertView[]
  /** `alert` is the default feed; `all` is the feed with the ticker included. */
  tier?: 'alert' | 'all'
  /** `updated` for the feed itself when there are no entries (RFC 4287 requires one). */
  fallbackUpdated: string
}

export const ALERTS_FEED_PATH = '/alerts.xml'

/** The two documents are two feeds: the one with the ticker has its own id and self link. */
export function feedPath(tier: 'alert' | 'all'): string {
  return tier === 'all' ? `${ALERTS_FEED_PATH}?${TICKER_FEED_QUERY}` : ALERTS_FEED_PATH
}

/** An Atom id must be an IRI. The alert's permalink when there is an origin, a URN otherwise. */
export function alertEntryId(appUrl: string, alertId: string): string {
  const origin = normalizeOrigin(appUrl)
  return origin ? `${origin}${alertPath(alertId)}` : `urn:sha256:${alertId}`
}

const SUBTITLE = {
  alert:
    'Judged and rule-fired alerts over the change log — notable and critical only. Every entry links to the source it was read from.',
  all: 'Alerts and the ticker over the change log — every severity. Every entry links to the source it was read from.',
} as const

export function buildAlertsAtom(input: AlertsFeedInput): string {
  const tier = input.tier ?? 'alert'
  const origin = normalizeOrigin(input.appUrl)
  const feedId = origin
    ? `${origin}${feedPath(tier)}`
    : `urn:frontier-terminal:alerts${tier === 'all' ? ':with-ticker' : ''}`
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
    `  <title>${escapeXml(`${input.appName} — ${tier === 'all' ? 'alerts and ticker' : 'alerts'}`)}</title>`,
    `  <subtitle>${escapeXml(SUBTITLE[tier])}</subtitle>`,
    `  <updated>${escapeXml(updated)}</updated>`,
    `  <author><name>${escapeXml(input.appName)}</name></author>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(feedId)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(`${site}/alerts`)}"/>`,
  ]

  return [...head, ...entries, '</feed>', ''].join('\n')
}
