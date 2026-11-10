import { describe, expect, it } from 'vitest'

import { checkReading, revenueExcerpts } from '../../server/pipeline/judge/filing-review'

// The Worker's checks on a filing reading, on text shaped like a real cover
// and MD&A: the model finds the sentence, the Worker decides what it says.

const COVER =
  'We anticipate that the initial public offering price per share will be between $70.00 and $78.00 per share. ' +
  'We have applied to list our Class A common stock on the Nasdaq Global Select Market under the symbol “ANT.”'
const BODY =
  'Revenue increased $19.7 billion, or 146%, from $13.5 billion for the nine months ended September 30, 2025 ' +
  'to $33.2 billion for the nine months ended September 30, 2026. Other text follows.'
const doc = { cover: COVER, body: BODY }
const SOURCE = 'prospectus-revenue-anthropic-s-1-a-2026-11-10-0001628280-26-072484'

const offering = (over: Record<string, unknown> = {}) =>
  ({
    source_id: SOURCE,
    part: 'offering',
    quote:
      'We anticipate that the initial public offering price per share will be between $70.00 and $78.00 per share.',
    price_low: 70,
    price_high: 78,
    price: null,
    ...over,
  }) as Parameters<typeof checkReading>[0]

describe('a cover reading', () => {
  it('holds when both prices are written to the cent in a per-share sentence on the cover', () => {
    expect(checkReading(offering(), doc)).toMatchObject({
      ok: true,
      checked: { part: 'offering', values: { price_low: 70, price_high: 78, price: null } },
    })
  })

  it('refuses a price the sentence does not write, half a range, or a quote off the cover', () => {
    expect(checkReading(offering({ price_high: 80 }), doc)).toMatchObject({
      ok: false,
      reason: 'price-not-in-quote',
    })
    expect(checkReading(offering({ price_high: null }), doc)).toMatchObject({
      ok: false,
      reason: 'no-price-range-or-price',
    })
    expect(checkReading(offering(), { cover: '', body: COVER })).toMatchObject({
      ok: false,
      reason: 'quote-not-in-document',
    })
  })
})

describe('a revenue reading', () => {
  const revenue = (over: Record<string, unknown> = {}) =>
    ({
      source_id: SOURCE,
      part: 'revenue',
      quote: BODY.split('. ')[0]! + '.',
      amount: '$33.2 billion',
      months: 9,
      period_end: '2026-09-30',
      ...over,
    }) as Parameters<typeof checkReading>[0]

  it('reads the latest period’s amount from a from-to sentence', () => {
    expect(checkReading(revenue(), doc)).toMatchObject({
      ok: true,
      checked: { values: { val: 33_200_000_000, months: 9, end: '2026-09-30' } },
    })
  })

  it('refuses the change, the earlier period, or a period the sentence does not name', () => {
    expect(checkReading(revenue({ amount: '$19.7 billion' }), doc)).toMatchObject({
      ok: false,
      reason: 'amount-not-for-period',
    })
    expect(
      checkReading(revenue({ amount: '$13.5 billion', period_end: '2025-09-30' }), doc),
    ).toMatchObject({ ok: false, reason: 'not-the-latest-period' })
    expect(checkReading(revenue({ months: 6 }), doc)).toMatchObject({
      ok: false,
      reason: 'period-not-in-quote',
    })
  })

  it('offers the runs of text that put revenue beside an amount and a period', () => {
    expect(revenueExcerpts(BODY)).toEqual([BODY])
    expect(revenueExcerpts('Revenue is recognized when control transfers.')).toEqual([])
  })
})
