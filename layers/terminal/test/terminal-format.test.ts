import { describe, expect, it } from 'vitest'

import {
  UTC_STYLE,
  absoluteStamp,
  compactTokens,
  compactUsd,
  count,
  exactStamp,
  hostOf,
  money,
  pctChange,
  pctLabel,
  relativeStamp,
  signed,
  zoneName,
} from '../shared/utils/terminal-format'
import { DEFAULTS, labsFirst, parsePrefs } from '../shared/utils/reader-prefs'

// How a stored value reads. The rule is relative inside a day, absolute
// beyond it, exact value always one hover away — and never a relative label
// rendered on the server, whose clock is not the reader's.

const NOW = Date.parse('2026-08-25T23:30:00Z')

describe('timestamps', () => {
  it('read relative inside a day, absolute beyond it', () => {
    expect(relativeStamp('2026-08-25T23:29:40Z', NOW)).toBe('just now')
    expect(relativeStamp('2026-08-25T23:12:00Z', NOW)).toBe('18m ago')
    expect(relativeStamp('2026-08-25T11:10:41Z', NOW)).toBe('12h ago')
    expect(relativeStamp('2026-08-20T11:10:41Z', NOW)).toBe('Aug 20 11:10Z')
    expect(relativeStamp('2025-12-31T09:00:00Z', NOW)).toBe('Dec 31 2025 09:00Z')
  })

  it('server render (no clock) is always absolute, so hydration cannot mismatch', () => {
    expect(relativeStamp('2026-08-25T23:12:00Z', null)).toBe('Aug 25 23:12Z')
    // A stamp ahead of the clock is never guessed at either.
    expect(relativeStamp('2026-08-26T02:00:00Z', NOW)).toBe('Aug 26 02:00Z')
    expect(absoluteStamp('2026-09-07T10:00:01.000Z')).toBe('Sep 7 10:00Z')
  })

  it('keeps the exact stored value for the tooltip and an unparseable one verbatim', () => {
    expect(exactStamp('2026-08-25T11:10:41Z')).toBe('2026-08-25T11:10:41Z')
    expect(relativeStamp('not a date', NOW)).toBe('not a date')
  })
})

describe('a reader’s zone and clock', () => {
  const NY = { ...UTC_STYLE, zone: 'America/New_York' }

  it('reads an instant in the reader’s zone, naming it', () => {
    expect(absoluteStamp('2026-08-25T23:08:00Z', NOW, NY)).toBe('Aug 25 19:08 EDT')
    expect(absoluteStamp('2026-12-01T15:00:00Z', NOW, NY)).toBe('Dec 1 10:00 EST')
    expect(absoluteStamp('2026-08-25T23:08:00Z', NOW, { ...UTC_STYLE, zone: 'Asia/Kolkata' })).toBe(
      'Aug 26 04:38 GMT+5:30',
    )
  })

  it('takes the year from the reader’s zone, not UTC’s', () => {
    const jan1 = Date.parse('2027-01-01T02:00:00Z')
    // 21:00 on Dec 31 in New York: the same year as the reader's clock there.
    expect(absoluteStamp('2027-01-01T02:00:00Z', jan1, NY)).toBe('Dec 31 21:00 EST')
    expect(absoluteStamp('2027-01-01T02:00:00Z', jan1)).toBe('Jan 1 02:00Z')
  })

  it('prints a 12-hour clock and ISO dates on request', () => {
    const h12 = { ...NY, hour12: true }
    expect(absoluteStamp('2026-08-25T23:08:00Z', NOW, h12)).toBe('Aug 25 7:08 PM EDT')
    expect(absoluteStamp('2026-08-25T04:05:00Z', NOW, h12)).toBe('Aug 25 12:05 AM EDT')
    expect(absoluteStamp('2026-08-25T16:30:00Z', NOW, { ...UTC_STYLE, hour12: true })).toBe(
      'Aug 25 4:30 PM UTC',
    )
    expect(absoluteStamp('2026-08-25T23:08:00Z', NOW, { ...NY, iso: true })).toBe(
      '2026-08-25 19:08 EDT',
    )
  })

  it('stays absolute when the reader turns ages off', () => {
    const off = { ...UTC_STYLE, relative: false }
    expect(relativeStamp('2026-08-25T23:12:00Z', NOW, off)).toBe('Aug 25 23:12Z')
  })

  it('names the zone for copy', () => {
    expect(zoneName(UTC_STYLE)).toBe('UTC')
    expect(zoneName(NY)).toBe('America/New York')
  })
})

describe('stored reader settings', () => {
  it('fall back field by field, so one bad value keeps the rest', () => {
    expect(parsePrefs(null)).toEqual(DEFAULTS)
    expect(parsePrefs({ zone: 'Mars/Olympus', clock: '12h', dates: 7 })).toEqual({
      ...DEFAULTS,
      clock: '12h',
    })
    expect(parsePrefs({ zone: 'Europe/London' }).zone).toBe('Europe/London')
  })

  it('keep only tracked labs, in registry order', () => {
    expect(parsePrefs({ watchlist: ['xai', 'nope', 'openai'] }).watchlist).toEqual([
      'openai',
      'xai',
    ])
  })

  it('put starred labs first without reordering either group', () => {
    const rows = ['openai', 'anthropic', 'google', 'xai'].map((lab) => ({ lab }))
    expect(labsFirst(rows, (r) => r.lab, ['google', 'xai']).map((r) => r.lab)).toEqual([
      'google',
      'xai',
      'openai',
      'anthropic',
    ])
    expect(labsFirst(rows, (r) => r.lab, [])).toEqual(rows)
  })
})

describe('money', () => {
  it('prints two decimals by default and never rounds a vendor digit away', () => {
    expect(money(null)).toBe('—')
    expect(money(2)).toBe('$2.00')
    expect(money(12.5)).toBe('$12.50')
    // Sub-cent precision is the vendor's, not ours: a flat toFixed(2) quoted
    // Gemini's $0.075 as $0.07.
    expect(money(0.075)).toBe('$0.075')
    expect(money(0.0375)).toBe('$0.0375')
    expect(money(0.0001)).toBe('$0.0001')
    expect(money(1.125)).toBe('$1.125')
  })

  it('percent change carries a visible sign and refuses a zero base', () => {
    expect(pctChange(2, 2.5)).toBe(25)
    expect(pctChange(0, 2)).toBeNull()
    expect(pctChange(null, 2)).toBeNull()
    expect(pctLabel(25)).toBe('+25%')
    expect(pctLabel(-33.333)).toBe('−33.3%')
    expect(pctLabel(0)).toBe('0%')
  })
})

describe('small helpers', () => {
  it('names a host and groups a count', () => {
    expect(hostOf('https://boards-api.greenhouse.io/v1/boards/xai/jobs')).toBe(
      'boards-api.greenhouse.io',
    )
    expect(hostOf('https://www.example.com/x')).toBe('example.com')
    expect(hostOf('not a url')).toBe('not a url')
    expect(count(1234567)).toBe('1,234,567')
  })
})

describe('compact figures', () => {
  it('roll over to the next unit rather than print a thousand of this one', () => {
    expect(compactUsd(999.6e6)).toBe('$1.00B')
    expect(compactUsd(999.4e6)).toBe('$999M')
    expect(compactUsd(99.96e6)).toBe('$100M')
    expect(compactUsd(9.996e6)).toBe('$10.0M')
    expect(compactUsd(999.6)).toBe('$1.00K')
    expect(compactUsd(-7.81e9)).toBe('−$7.81B')
    expect(compactUsd(412)).toBe('$412')
    expect(compactTokens(999.7e9)).toBe('1.00T')
    expect(compactTokens(15e6)).toBe('15.0M')
    expect(compactTokens(910e9)).toBe('910B')
    expect(compactTokens(42)).toBe('42')
  })
})

describe('signed', () => {
  it('always shows the sign, with a true minus and a visible zero', () => {
    expect(signed(12)).toBe('+12')
    expect(signed(-3)).toBe('−3')
    expect(signed(0)).toBe('±0')
    expect(signed(1234)).toBe('+1,234')
  })
})
