import { describe, expect, it } from 'vitest'

import {
  ALERT_TIER_FILTERS,
  alertPath,
  alertTier,
  severitiesOf,
  TICKER_FEED_QUERY,
} from '../shared/utils/terminal-tiers'

// The materiality split, pinned: every surface (signal band, /alerts, the
// feed, the sitemap) reads severity through these, so the mapping is a
// contract rather than a convention.

describe('alertTier', () => {
  it('reads info as the ticker and notable/critical as alerts', () => {
    expect(alertTier('info')).toBe('ticker')
    expect(alertTier('notable')).toBe('alert')
    expect(alertTier('critical')).toBe('alert')
  })

  it('severitiesOf partitions the enum exactly', () => {
    expect(severitiesOf('alert')).toEqual(['notable', 'critical'])
    expect(severitiesOf('ticker')).toEqual(['info'])
    expect(severitiesOf('all')).toEqual(['info', 'notable', 'critical'])
    expect([...severitiesOf('alert'), ...severitiesOf('ticker')].sort()).toEqual(
      [...severitiesOf('all')].sort(),
    )
    expect(ALERT_TIER_FILTERS).toEqual(['alert', 'ticker', 'all'])
  })

  it('names the permalink and the feed flag in one place', () => {
    expect(alertPath('abc')).toBe('/alerts/abc')
    expect(TICKER_FEED_QUERY).toBe('include=ticker')
  })
})
