import { describe, expect, it } from 'vitest'

import {
  absoluteStamp,
  count,
  exactStamp,
  hostOf,
  money,
  pctChange,
  pctLabel,
  relativeStamp,
} from '../shared/utils/terminal-format'

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
