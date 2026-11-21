import { describe, expect, it } from 'vitest'

import {
  UTC_STYLE,
  absoluteStamp,
  boardLabel,
  compactCount,
  compactTokens,
  compactUsd,
  count,
  datedStamp,
  dayStamp,
  edgarName,
  exactStamp,
  exactUsd,
  fullDayStamp,
  gpuHour,
  grouped,
  hostOf,
  money,
  readableEdgarNames,
  splitInstants,
  tierLabel,
  pctChange,
  pctLabel,
  percent,
  preciseUsd,
  relativeStamp,
  roundBillions,
  signed,
  signedPercent,
  trimmed,
  zoneName,
} from '#layers/core/shared/utils/terminal-format'
import { formatTick, formatValue } from '../shared/utils/thesis-format'
import { millions, statementValue } from '../../companies/shared/utils/terminal-prospectus'
import { DEFAULTS, labsFirst, parsePrefs } from '../../core/shared/utils/reader-prefs'

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

// The 2026-11-20 design review: figures that drifted between forms on one page.

describe('GPU-hour prices', () => {
  it('read at two decimals so a column lines up, with the printed value kept for the tooltip', () => {
    // One column mixed $6.155, $14.3793 and $2.49.
    expect(gpuHour(6.155)).toBe('$6.16')
    expect(gpuHour(14.3793)).toBe('$14.38')
    expect(gpuHour(2.49)).toBe('$2.49')
    expect(gpuHour(3)).toBe('$3.00')
    expect(gpuHour(null)).toBe('—')
    expect(exactUsd(6.155)).toBe('$6.155')
    expect(exactUsd(14.3793)).toBe('$14.3793')
  })
})

describe('compactCount', () => {
  it('scales a count to K or M instead of printing 0.03M or 0.00M', () => {
    expect(compactCount(30_000)).toBe('30.0K')
    expect(compactCount(1_240_000)).toBe('1.24M')
    expect(compactCount(640)).toBe('640')
    expect(compactCount(0)).toBe('0')
    expect(compactCount(999_600)).toBe('1.00M')
    expect(compactCount(-12_500)).toBe('−12.5K')
  })
})

describe('grouped', () => {
  it('prints a negative with U+2212, never the hyphen toLocaleString gives', () => {
    expect(grouped(-1260)).toBe('−1,260')
    expect(grouped(33_242)).toBe('33,242')
    expect(grouped(-0.004, 2)).toBe('0.00')
    expect(grouped(-4.25, 2)).toBe('−4.25')
  })

  it('reaches the prospectus statement in every unit', () => {
    expect(statementValue(-1_260_000, 'shares')).toBe('−1,260')
    expect(statementValue(-1_260_000_000, 'USD')).toBe('−1,260')
    expect(statementValue(-0.42, 'USD/share')).toBe('−0.42')
    expect(millions(-1_260_400_000)).toBe('−1,260.4')
    expect(statementValue(null, 'USD')).toBe('—')
    for (const v of [statementValue(-1_260_000, 'shares'), millions(-5e8)]) {
      expect(v).not.toContain('-')
    }
  })
})

describe('thesis axis ticks', () => {
  it('drop the reading’s fixed decimals on a round tick', () => {
    expect(formatValue('ratio', 10)).toBe('10.00×')
    expect(formatTick('ratio', 10)).toBe('10×')
    expect(formatTick('ratio', 2.5)).toBe('2.5×')
    expect(formatTick('ratio', 0.25)).toBe('0.25×')
    expect(formatTick('share', 0.25)).toBe(formatValue('share', 0.25))
  })
})

describe('dayStamp / datedStamp', () => {
  it('reads a date printed alone in the reader’s date form, never moved by the zone', () => {
    expect(dayStamp('2026-08-03', NOW)).toBe('Aug 3')
    expect(dayStamp('2025-08-03', NOW)).toBe('Aug 3 2025')
    const tokyo = { zone: 'Asia/Tokyo', hour12: false, iso: false, relative: true }
    const nyIso = { zone: 'America/New_York', hour12: true, iso: true, relative: true }
    expect(dayStamp('2026-08-03', NOW, tokyo)).toBe('Aug 3')
    expect(dayStamp('2026-08-03', NOW, nyIso)).toBe('2026-08-03')
    expect(dayStamp('soon', NOW)).toBe('soon')
  })

  it('names the year of a filing period or a planned date, with no clock to drop it', () => {
    expect(fullDayStamp('2026-09-30')).toBe('Sep 30 2026')
    expect(fullDayStamp('2028-03-17T00:00:00Z')).toBe('Mar 17 2028')
    const nyIso = { zone: 'America/New_York', hour12: true, iso: true, relative: true }
    expect(fullDayStamp('2026-09-30', nyIso)).toBe('2026-09-30')
    expect(fullDayStamp('soon')).toBe('soon')
  })

  it('always names the year on a printed stamp', () => {
    expect(datedStamp('2026-08-25T23:08:00Z')).toBe('Aug 25 2026 23:08Z')
    const nyIso = { zone: 'America/New_York', hour12: true, iso: true, relative: true }
    expect(datedStamp('2026-11-20T15:30:00Z', nyIso)).toBe('2026-11-20 10:30 AM EST')
  })
})

describe('splitInstants', () => {
  it('lifts the instants out of a citation and keeps the rest byte-identical', () => {
    const citation =
      'Source: OpenRouter (openrouter.ai/rankings), as of 2026-09-09T12:00:03.352Z. Licensed under CC BY 4.0.'
    const parts = splitInstants(citation)
    expect(parts).toEqual([
      { text: 'Source: OpenRouter (openrouter.ai/rankings), as of ' },
      { iso: '2026-09-09T12:00:03.352Z' },
      { text: '. Licensed under CC BY 4.0.' },
    ])
    expect(parts.map((p) => ('iso' in p ? p.iso : p.text)).join('')).toBe(citation)
    expect(splitInstants('no stamp here')).toEqual([{ text: 'no stamp here' }])
  })
})

describe('labels', () => {
  it('reads a board’s enum department as a phrase and leaves typed labels alone', () => {
    expect(boardLabel('SOFTWARE_ENGINEERING')).toBe('Software engineering')
    expect(boardLabel('PROGRAM_MANAGEMENT, SOFTWARE_ENGINEERING')).toBe(
      'Program management, Software engineering',
    )
    expect(boardLabel('Go To Market')).toBe('Go To Market')
    expect(boardLabel('AI Research & Engineering')).toBe('AI Research & Engineering')
    expect(boardLabel('IT')).toBe('IT')
  })

  it('reads a vendor’s tier key as words', () => {
    expect(tierLabel('batch_long_context')).toBe('Batch, long context')
    expect(tierLabel('long_context')).toBe('Long context')
    expect(tierLabel('ultrafast_long_context')).toBe('Ultrafast, long context')
    expect(tierLabel('off_peak')).toBe('Off-peak')
    expect(tierLabel('input_256k_1m')).toBe('Input 256K–1M')
    expect(tierLabel('input_32k_256k')).toBe('Input 32K–256K')
    expect(tierLabel('batch')).toBe('Batch')
  })

  it('reads an EDGAR conformed name in the company’s case', () => {
    expect(edgarName('NVIDIA CORP')).toBe('NVIDIA Corp')
    expect(edgarName('MICROSOFT CORP')).toBe('Microsoft Corp')
    expect(edgarName('AMAZON COM INC')).toBe('Amazon Com Inc')
    expect(edgarName('SPACE EXPLORATION TECHNOLOGIES CORP')).toBe(
      'Space Exploration Technologies Corp',
    )
    expect(edgarName('META PLATFORMS, INC.')).toBe('Meta Platforms, Inc.')
    expect(edgarName('Anthropic, PBC')).toBe('Anthropic, PBC')
  })

  it('fixes the names inside a headline and nothing else', () => {
    expect(readableEdgarNames('NVIDIA CORP files an 8-K with items "2.02 Results"')).toBe(
      'NVIDIA Corp files an 8-K with items "2.02 Results"',
    )
    expect(readableEdgarNames('10-Q filed by MICROSOFT CORP (2026-10-28)')).toBe(
      '10-Q filed by Microsoft Corp (2026-10-28)',
    )
    expect(readableEdgarNames('424B4 filed by Anthropic, PBC (2026-11-19)')).toBe(
      '424B4 filed by Anthropic, PBC (2026-11-19)',
    )
    expect(readableEdgarNames('SEC EDGAR XBRL facts')).toBe('SEC EDGAR XBRL facts')
  })
})

// Panels used to carry their own percent, billions and hours helpers: the same
// median error read '12%' on one page and '12.0%' on another, and a negative
// printed toFixed's hyphen.

describe('figures every panel shares', () => {
  it('trims a figure for prose and keeps the true minus', () => {
    expect(trimmed(12)).toBe('12')
    expect(trimmed(12.34)).toBe('12.3')
    expect(trimmed(1260.5)).toBe('1,260.5')
    expect(trimmed(-0.44)).toBe('−0.4')
    expect(trimmed(-0.04)).toBe('0')
    expect(percent(12)).toBe('12%')
    expect(percent(0.94)).toBe('0.9%')
  })

  it('signs an error at one decimal, with ± for one that rounds to nothing', () => {
    expect(signedPercent(0.94)).toBe('+0.9%')
    expect(signedPercent(-0.94)).toBe('−0.9%')
    expect(signedPercent(12)).toBe('+12.0%')
    expect(signedPercent(0)).toBe('±0.0%')
    expect(signedPercent(-0.04)).toBe('±0.0%')
  })

  it('prints a stated figure in round billions and a filed one at two decimals', () => {
    expect(roundBillions(38e9)).toBe('$38B')
    expect(roundBillions(38.5e9)).toBe('$38.5B')
    expect(roundBillions(1250e9)).toBe('$1,250B')
    expect(preciseUsd(17e9)).toBe('$17.00B')
    expect(preciseUsd(16.85e9)).toBe('$16.85B')
    expect(preciseUsd(-1.2e9)).toBe('−$1.20B')
    expect(preciseUsd(412e6)).toBe('$412M')
  })
})

// A figure formatted in a component is one more form on the page. The shared
// modules own toLocaleString and toFixed; a component that needs a new form
// adds it there. The three files below call them for something else.
const NOT_FIGURES: Record<string, string> = {
  'components/Terminal/Sparkline.vue': 'SVG path coordinates',
  'components/Terminal/LineChart.vue': 'SVG path coordinates and a CSS offset',
  'components/Terminal/AdoptionRamp.vue': 'a month label, from a Date',
}

describe('app code formats figures through the shared module', () => {
  const sources = {
    ...import.meta.glob<string>('../../*/app/**/*.{vue,ts}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
    ...import.meta.glob<string>('../../../app/**/*.{vue,ts}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  }
  const offenders = Object.entries(sources)
    .filter(([path]) => !Object.keys(NOT_FIGURES).some((skip) => path.endsWith(skip)))
    .filter(([, text]) => /\.toLocaleString\(|\.toFixed\(|Intl\.NumberFormat/.test(text))
    .map(([path]) => path)

  it('reads the sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100)
  })

  it('no component or page calls toLocaleString, toFixed or Intl.NumberFormat', () => {
    expect(offenders).toEqual([])
  })
})
