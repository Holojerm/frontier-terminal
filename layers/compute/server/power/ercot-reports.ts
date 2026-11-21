// ERCOT's large-load figures, parsed from its monthly PDFs (fetch and store are in
// ercot-large-loads.ts). The Monthly Operational Overview carries one sentence
// ("Of the 9,456 MW that have received Approval to Energize, ERCOT has observed a
// non-simultaneous monthly peak consumption of 4,132 MW in September 2026"); the
// month it names isn't always the report's, and later reports restate months, so
// each report is a vintage. The ERCOT Monthly states the queue in varying words;
// only the wordings below are read.

export type ErcotSeries = 'operational-overview' | 'monthly'

const ERCOT_ORIGIN = 'https://www.ercot.com'
const ERCOT_BOARD_URL = `${ERCOT_ORIGIN}/committees/board`
const ERCOT_PRESENTATIONS_URL = `${ERCOT_ORIGIN}/news/presentations`
/** The first year whose overviews state the observed figure. */
const ERCOT_FIRST_YEAR = 2025

/** The listing pages a run reads: the Board page, each earlier year's, and the presentations page. */
export function ercotListings(now: Date): { url: string; series: ErcotSeries }[] {
  const out: { url: string; series: ErcotSeries }[] = [
    { url: ERCOT_BOARD_URL, series: 'operational-overview' },
  ]
  for (let y = ERCOT_FIRST_YEAR; y < now.getUTCFullYear(); y++) {
    out.push({ url: `${ERCOT_BOARD_URL}/${y}`, series: 'operational-overview' })
  }
  out.push({ url: ERCOT_PRESENTATIONS_URL, series: 'monthly' })
  return out
}

export interface ErcotReportLink {
  url: string
  series: ErcotSeries
  title: string
  /** YYYY-MM-DD, from ERCOT's /files/docs/YYYY/MM/DD/ path. */
  posted: string
}

const DOC_RE =
  /(?:https:\/\/www\.ercot\.com)?(\/files\/docs\/(\d{4})\/(\d{2})\/(\d{2})\/[^"'\s<>]+\.pdf)/gi

const titleOf = (path: string) =>
  decodeURIComponent(path.split('/').pop()!)
    .replace(/\.pdf$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\bFINAL\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The reports of one series a listing page links to. */
export function ercotReportLinks(html: string, series: ErcotSeries): ErcotReportLink[] {
  const out = new Map<string, ErcotReportLink>()
  for (const m of html.matchAll(DOC_RE)) {
    const path = m[1]!
    const name = path.split('/').pop()!.toLowerCase()
    const overview = name.includes('operational-overview')
    if (series === 'operational-overview' ? !overview : overview || !/^ercot-monthly-/.test(name))
      continue
    const url = `${ERCOT_ORIGIN}${path}`
    out.set(url, { url, series, title: titleOf(path), posted: `${m[2]}-${m[3]}-${m[4]}` })
  }
  return [...out.values()].sort((a, b) => a.posted.localeCompare(b.posted))
}

type ErcotMetric =
  | 'approved_to_energize_mw'
  | 'observed_peak_mw'
  | 'observed_energized_mw'
  | 'approved_not_operational_mw'
  | 'queue_mw'

interface ErcotFact {
  metric: ErcotMetric
  /** YYYY-MM */
  period: string
  value: number
  qualifier: string | null
  horizon: string | null
  /** The sentence, as the PDF's text reads once its spacing is collapsed. */
  quote: string
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]
const MONTH = `(${MONTHS.join('|')})`

const num = (s: string) => Number(s.replace(/,/g, ''))
const monthKey = (name: string, year: string) =>
  `${year}-${String(MONTHS.indexOf(name.toLowerCase()) + 1).padStart(2, '0')}`

/** The sentence a match sits in: back to the last sentence end, on to the next. */
function sentence(text: string, from: number, to: number): string {
  let start = 0
  for (const m of text.slice(0, from).matchAll(/[.!?•–]\s/g)) start = m.index + m[0].length
  const end = /\.(?=\s|$)/.exec(text.slice(to))
  return text.slice(start, end ? to + end.index + 1 : to).trim()
}

const OBSERVED = new RegExp(
  `Of the\\s+(\\d[\\d,]*)\\s*MW that have received Approval to Energize,\\s*ERCOT has observed a non\\s*-?\\s*simultaneous monthly peak consumption of\\s+(\\d[\\d,]*)\\s*MW in\\s+${MONTH}\\s+(\\d{4})`,
  'gi',
)

const QUEUE: { re: RegExp; qualifier: string | null }[] = [
  {
    re: /applications of large loads now totaling\s+(\d[\d,.]*)\s*gigawatts\s*\(GW\)(?:\s*by\s+(\d{4}))?/gi,
    qualifier: null,
  },
  {
    re: /more than\s+(\d[\d,.]*)\s*gigawatts\s*\(GW\)\s*of Large Loads currently seeking interconnection()/gi,
    qualifier: 'more than',
  },
  {
    re: /models roughly\s+(\d[\d,.]*)\+?\s*gigawatts\s*\(GW\)\s*of requested load()/gi,
    qualifier: 'roughly',
  },
]

const ENERGIZED =
  /ERCOT has\s+(\d[\d,.]*)\s*GW of Observed Energized Large Loads,\s*with another\s+(\d[\d,.]*)\s*GW of loads that have Approval to Energize but are not Operational/gi

/** Plausible megawatts for one of these figures: a misread digit lands outside. */
const plausible = (mw: number) => Number.isFinite(mw) && mw >= 100 && mw <= 2_000_000

/** The month a report is for, from its title ("… April 2026"), else the month before it was posted. */
export function reportPeriod(link: Pick<ErcotReportLink, 'title' | 'posted'>): string {
  const m = new RegExp(`${MONTH}\\s+(\\d{4})`, 'i').exec(link.title)
  if (m) return monthKey(m[1]!, m[2]!)
  const [y, mo] = link.posted.split('-').map(Number) as [number, number]
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
}

/**
 * Every figure the report's text states, in the wordings above. Throws when a
 * sentence is found but its numbers are not plausible: a misread is a failure,
 * never a stored figure.
 */
export function ercotFacts(pages: readonly string[], link: ErcotReportLink): ErcotFact[] {
  const text = pages.join(' ').replace(/\s+/g, ' ')
  const out: ErcotFact[] = []
  const period = reportPeriod(link)
  for (const m of text.matchAll(OBSERVED)) {
    const approved = num(m[1]!)
    const observed = num(m[2]!)
    if (!plausible(approved) || !plausible(observed) || observed > approved) {
      throw new Error(
        `implausible large-load figures: ${approved} MW approved, ${observed} MW observed`,
      )
    }
    const quote = sentence(text, m.index, m.index + m[0].length)
    const month = monthKey(m[3]!, m[4]!)
    const base = { period: month, qualifier: null, horizon: null, quote }
    out.push({ ...base, metric: 'approved_to_energize_mw', value: approved })
    out.push({ ...base, metric: 'observed_peak_mw', value: observed })
  }
  for (const { re, qualifier } of QUEUE) {
    for (const m of text.matchAll(re)) {
      const mw = num(m[1]!) * 1000
      if (!plausible(mw)) throw new Error(`implausible queue figure: ${m[1]} GW`)
      out.push({
        metric: 'queue_mw',
        period,
        value: mw,
        qualifier,
        horizon: m[2] || null,
        quote: sentence(text, m.index, m.index + m[0].length),
      })
    }
  }
  for (const m of text.matchAll(ENERGIZED)) {
    const energized = num(m[1]!) * 1000
    const waiting = num(m[2]!) * 1000
    if (!plausible(energized) || !plausible(waiting)) {
      throw new Error(`implausible energized figures: ${m[1]} GW, ${m[2]} GW`)
    }
    const quote = sentence(text, m.index, m.index + m[0].length)
    const base = { period, qualifier: null, horizon: null, quote }
    out.push({ ...base, metric: 'observed_energized_mw', value: energized })
    out.push({ ...base, metric: 'approved_not_operational_mw', value: waiting })
  }
  // A sentence repeated on two slides is one figure.
  const seen = new Set<string>()
  return out.filter((f) => {
    const k = `${f.metric}|${f.period}|${f.value}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
