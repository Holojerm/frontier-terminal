import { describe, expect, it } from 'vitest'

import {
  ALERT_TIER_FILTERS,
  alertPath,
  alertTier,
  CRITICAL_FEED_QUERY,
  severitiesOf,
  INFO_FEED_QUERY,
  tierFilterOf,
} from '../shared/utils/terminal-tiers'

// The materiality split, pinned: every surface (signal band, /alerts, the
// feed, the sitemap) reads severity through these, so the mapping is a
// contract rather than a convention.

describe('alertTier', () => {
  it('reads info as minor changes and notable/critical as alerts', () => {
    expect(alertTier('info')).toBe('info')
    expect(alertTier('notable')).toBe('alert')
    expect(alertTier('critical')).toBe('alert')
  })

  it('severitiesOf partitions the enum exactly', () => {
    expect(severitiesOf('alert')).toEqual(['notable', 'critical'])
    expect(severitiesOf('info')).toEqual(['info'])
    expect(severitiesOf('all')).toEqual(['info', 'notable', 'critical'])
    expect([...severitiesOf('alert'), ...severitiesOf('info')].sort()).toEqual(
      [...severitiesOf('all')].sort(),
    )
    expect(ALERT_TIER_FILTERS).toEqual(['alert', 'critical', 'info', 'all'])
  })

  it('narrows the alert tier to critical without making critical a tier', () => {
    expect(severitiesOf('critical')).toEqual(['critical'])
    expect(severitiesOf('alert')).toContain('critical')
    expect(alertTier('critical')).toBe('alert')
  })

  it('names the permalink and the feed flags in one place', () => {
    expect(alertPath('abc')).toBe('/alerts/abc')
    expect(INFO_FEED_QUERY).toBe('include=info')
    expect(CRITICAL_FEED_QUERY).toBe('tier=critical')
  })

  it('reads the old ticker tier name as info, so saved URLs keep working', () => {
    expect(tierFilterOf('ticker')).toBe('info')
    expect(tierFilterOf('alert')).toBe('alert')
    expect(tierFilterOf(undefined)).toBeUndefined()
  })
})
