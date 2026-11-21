// Pure parsers for the print sources: bytes in, observations out. A body that
// isn't what the source sends throws; nothing here guesses a figure.

import {
  PRINT_ENTITY,
  PRINT_ENTITY_BY_CODE,
  type PrintObservedAs,
  type PrintSeries,
  type PrintWindow,
} from '../../shared/utils/prints'
import { pageText } from '../utils/quote-match'

/** One figure a release states. The store decides whether it is new. */
export interface PrintObservation {
  series: PrintSeries
  entity: string
  ticker: string | null
  period: string
  window: PrintWindow
  value: number
  currency: 'TWD' | 'USD'
  yoy_pct: number | null
  observed_as: PrintObservedAs
  published_at: string | null
  due_on: string | null
}

/** "2026-10" shifted by `months`. */
export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const i = y * 12 + (m - 1) + months
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`
}

/** Taiwan's deadline for a month's revenue: the 10th of the month after (Securities and Exchange Act art. 36). */
export const twDueOn = (period: string): string => `${shiftPeriod(period, 1)}-10`

// ── TWSE OpenAPI t187ap05_L ───────────────────────────────────────────────

interface TwseRow {
  資料年月?: string
  公司代號?: string
  '營業收入-當月營收'?: string
  '營業收入-上月營收'?: string
  '營業收入-去年當月營收'?: string
  '營業收入-去年同月增減(%)'?: string
}

/** "11510" (ROC year 115, month 10) → "2026-10". */
export function rocPeriod(yyymm: string): string {
  const m = /^(\d{2,3})(\d{2})$/.exec(yyymm.trim())
  if (!m) throw new Error(`not a ROC year-month: ${yyymm}`)
  const month = Number(m[2])
  if (month < 1 || month > 12) throw new Error(`not a ROC year-month: ${yyymm}`)
  return `${Number(m[1]) + 1911}-${m[2]}`
}

const thousands = (s: string | undefined, field: string): number => {
  const v = Number((s ?? '').replace(/,/g, '').trim())
  if (!Number.isFinite(v) || (s ?? '').trim() === '') throw new Error(`bad ${field}: ${s}`)
  return v * 1000
}

const pct = (s: string | undefined): number | null => {
  const v = Number((s ?? '').trim())
  return (s ?? '').trim() !== '' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null
}

/**
 * The tracked companies' rows of the exchange's monthly revenue feed. Each row
 * states the month (print), the month before and the same month a year
 * earlier, in NT$ thousand. A tracked company missing from the feed is not an
 * error (a late filer); a feed with none of them is.
 */
export function parseTwseRevenue(body: string): PrintObservation[] {
  const rows = JSON.parse(body) as TwseRow[]
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('not a t187ap05_L array')
  const out: PrintObservation[] = []
  for (const r of rows) {
    const entity = PRINT_ENTITY_BY_CODE.get((r.公司代號 ?? '').trim())
    if (!entity) continue
    const period = rocPeriod(r.資料年月 ?? '')
    const base = {
      series: 'tw_revenue' as const,
      entity: entity.id,
      ticker: entity.ticker,
      window: 'month' as const,
      currency: 'TWD' as const,
      published_at: null,
    }
    out.push(
      {
        ...base,
        period,
        value: thousands(r['營業收入-當月營收'], '當月營收'),
        yoy_pct: pct(r['營業收入-去年同月增減(%)']),
        observed_as: 'print',
        due_on: twDueOn(period),
      },
      {
        ...base,
        period: shiftPeriod(period, -1),
        value: thousands(r['營業收入-上月營收'], '上月營收'),
        yoy_pct: null,
        observed_as: 'prior_month',
        due_on: twDueOn(shiftPeriod(period, -1)),
      },
      {
        ...base,
        period: shiftPeriod(period, -12),
        value: thousands(r['營業收入-去年當月營收'], '去年當月營收'),
        yoy_pct: null,
        observed_as: 'year_ago',
        due_on: twDueOn(shiftPeriod(period, -12)),
      },
    )
  }
  if (out.length === 0) throw new Error('t187ap05_L has none of the tracked companies')
  return out
}

// ── TSMC's monthly revenue 6-K on EDGAR ───────────────────────────────────

export const TSMC_CIK = '0001046179'
/** The first month the backfill reads: the oldest 6-K in EDGAR's recent submissions list. */
export const TSMC_BACKFILL_FROM = '2015-01-01'

export interface TsmcCandidate {
  accession_no: string
  filed: string
  /** EDGAR's acceptance time, ISO 8601 UTC. */
  accepted_at: string
  url: string
}

/** Names of 6-Ks that are never the revenue report. */
const NOT_REVENUE = /board|agm|monthend|fsx|dividend|sony|directors|treasur|statement|change/i

/**
 * The 6-Ks in TSMC's submissions feed filed in the first twelve days of a
 * month since `from`: the revenue report is due by the 10th, and every other
 * 6-K in that window is read once and set aside.
 */
export function tsmcCandidates(body: string, from: string = TSMC_BACKFILL_FROM): TsmcCandidate[] {
  const doc = JSON.parse(body) as {
    cik?: string
    filings?: {
      recent?: {
        form: string[]
        accessionNumber: string[]
        filingDate: string[]
        acceptanceDateTime: string[]
        primaryDocument: string[]
      }
    }
  }
  const r = doc.filings?.recent
  if (!r) throw new Error('not an EDGAR submissions feed')
  if (Number(doc.cik) !== Number(TSMC_CIK))
    throw new Error(`submissions feed is for CIK ${doc.cik}`)
  const out: TsmcCandidate[] = []
  for (let i = 0; i < r.form.length; i++) {
    const filed = r.filingDate[i]!
    const primary = r.primaryDocument[i]!
    if (r.form[i] !== '6-K' || filed < from) continue
    if (Number(filed.slice(8, 10)) > 12 || NOT_REVENUE.test(primary)) continue
    if (!/^[\w.-]+\.html?$/i.test(primary)) continue
    const accession_no = r.accessionNumber[i]!
    out.push({
      accession_no,
      filed,
      accepted_at: new Date(r.acceptanceDateTime[i]!).toISOString(),
      url: `https://www.sec.gov/Archives/edgar/data/${Number(TSMC_CIK)}/${accession_no.replace(/-/g, '')}/${primary}`,
    })
  }
  return out.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0))
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const millions = (s: string) => Number(s.replace(/,/g, '')) * 1e6
/** "59.7" or "(23.1 )", the report's way of writing a decrease. */
const signed = (s: string) => {
  const neg = s.includes('(')
  const v = Number(s.replace(/[()\s]/g, ''))
  return neg ? -v : v
}

/**
 * The figures of a "TSMC <Month> <Year> Revenue Report" 6-K: the month, the
 * month before and the same month a year earlier, from its table in NT$
 * million. null for a 6-K that isn't one. A revenue report whose table
 * doesn't read throws.
 */
export function parseTsmcRevenue6k(html: string, accepted_at: string): PrintObservation[] | null {
  // Each cell is its own tag: a space where a tag was keeps adjacent figures apart.
  // Some 2020 reports write a decrease in full-width parentheses: "（12.3）".
  const text = pageText(html.replace(/<[^>]+>/g, ' '))
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, ' ')
  const head = new RegExp(`TSMC (${MONTHS.join('|')}) (\\d{4}) Revenue Report`).exec(text)
  if (!head) return null
  const period = `${head[2]}-${String(MONTHS.indexOf(head[1]!) + 1).padStart(2, '0')}`
  const n = '([\\d,]+)'
  const p = '(\\(?\\s*-?[\\d.]+\\s*\\)?)'
  const table = new RegExp(
    // "(Unit:NT$ million)", or "(in NT$ million)" as October 2019's report has it.
    `\\((?:Unit: ?|in )NT\\$ ?million\\).*?Net Revenues?\\s+${n}\\s+${n}\\s+${p}\\s+${n}\\s+${p}`,
  ).exec(text)
  if (!table) throw new Error(`TSMC ${period} revenue report: no table`)
  const base = {
    series: 'tw_revenue' as const,
    entity: 'tsmc',
    ticker: PRINT_ENTITY.get('tsmc')!.ticker,
    window: 'month' as const,
    currency: 'TWD' as const,
    published_at: accepted_at,
  }
  return [
    {
      ...base,
      period,
      value: millions(table[1]!),
      yoy_pct: signed(table[5]!),
      observed_as: 'print',
      due_on: twDueOn(period),
    },
    {
      ...base,
      period: shiftPeriod(period, -1),
      value: millions(table[2]!),
      yoy_pct: null,
      observed_as: 'prior_month',
      due_on: twDueOn(shiftPeriod(period, -1)),
    },
    {
      ...base,
      period: shiftPeriod(period, -12),
      value: millions(table[4]!),
      yoy_pct: null,
      observed_as: 'year_ago',
      due_on: twDueOn(shiftPeriod(period, -12)),
    },
  ]
}

// ── Accton's own monthly revenue page ─────────────────────────────────────

// The oldest rows leave the year-ago cells empty.
const ACCTON_ROW =
  /<tr><td>(\d{4})\/(\d{2})<\/td><td[^>]*>([\d,]+)<\/td><td[^>]*>(?:-?[\d.]+%)?<\/td><td[^>]*>([\d,]*)<\/td><td[^>]*>(?:(-?[\d.]+)%)?<\/td>/g

/**
 * Every month in Accton's revenue table (accton.com/monthly-merge), in NT$
 * thousand: the month's revenue with its stated YoY change, and the same
 * month a year earlier as the table restates it.
 */
export function parseAcctonRevenue(html: string): PrintObservation[] {
  if (!html.includes('In thousands of New Taiwan dollars')) {
    throw new Error('accton: the unit line is gone')
  }
  const out: PrintObservation[] = []
  const base = {
    series: 'tw_revenue' as const,
    entity: 'accton',
    ticker: PRINT_ENTITY.get('accton')!.ticker,
    window: 'month' as const,
    currency: 'TWD' as const,
    published_at: null,
  }
  for (const m of html.matchAll(ACCTON_ROW)) {
    const period = `${m[1]}-${m[2]}`
    out.push({
      ...base,
      period,
      value: thousands(m[3], 'revenue'),
      yoy_pct: m[5] === undefined ? null : Number(m[5]),
      observed_as: 'print',
      due_on: twDueOn(period),
    })
    if (!m[4]) continue
    out.push({
      ...base,
      period: shiftPeriod(period, -12),
      value: thousands(m[4], 'same month last year'),
      yoy_pct: null,
      observed_as: 'year_ago',
      due_on: twDueOn(shiftPeriod(period, -12)),
    })
  }
  if (out.length === 0) throw new Error('accton: no revenue rows')
  return out
}
