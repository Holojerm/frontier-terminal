// Forward-looking numeric guidance in a call document, read deterministically.
//
// A sentence is taken when it looks ahead (expect, anticipate, guidance, outlook…), does
// not report a result already in (was, came in, exceeded…), isn't a question, and states
// an amount after a metric it names: capex, revenue (total, a segment's, or an AI line),
// gross margin, or backlog. The amount is the first after the metric word: a range
// ("$73 - 76 billion", "between 11% and 13%"), a figure with a band ("$108 billion, plus
// or minus 2%", "74%, plus or minus 50 basis points"), or one figure (about, at least, at
// most). A growth rate on revenue is kept as growth, year on year or sequential.
//
// The period is the one the sentence names ("the fourth quarter", "Q4", "fiscal 2027",
// "full year"), else a nearby outlook sentence's, else the next quarter for a "plus or
// minus" figure. A period not after the reported quarter is a result and is dropped.
// Anything else the parser can't place is left for the judge (review.ts). Pure.

import { fiscalPeriod, nextQuarter, quarterEnding, type FiscalPeriod } from './periods'
import type { DocSentence } from './text'

export const METRICS = [
  'capex',
  'revenue',
  'segment_revenue',
  'ai_revenue',
  'gross_margin',
  'backlog',
] as const
export type Metric = (typeof METRICS)[number]
export const UNITS = ['USD', 'percent', 'growth_yoy', 'growth_qoq'] as const
export type GuidanceUnit = (typeof UNITS)[number]
export const BOUNDS = ['range', 'about', 'at_least', 'at_most'] as const
export type GuidanceBound = (typeof BOUNDS)[number]

/** A published quote is at most this many words of the sentence. */
export const QUOTE_MAX_WORDS = 25

export interface Statement {
  metric: Metric
  segment: string | null
  basis: 'gaap' | 'non_gaap' | null
  unit: GuidanceUnit
  bound: GuidanceBound
  low: number
  high: number
  period: FiscalPeriod
  quote: string
  /** The whole sentence, kept with the private text only. */
  sentence: string
  page: number | null
  at_ms: number | null
  speaker: string | null
}

export interface ExtractContext {
  fyEndMonth: number
  /** The quarter the call reported. */
  reported: FiscalPeriod
  /** When set, only sentences these speakers said (a transcribed replay). */
  speakers?: readonly string[]
}

const FORWARD =
  /\b(?:expect(?:s|ed|ing)?|anticipat(?:e|es|ing)|guid(?:e|ance|ing)|outlook|forecast(?:s|ing)?|project(?:s|ing)?|we see|target(?:s|ing)?|plan(?:s)? to|now (?:see|estimate))\b/i
// A result already in, or guidance being recalled rather than given.
const PAST =
  /\b(?:was|were|came in|reported|delivered|reached|totall?ed|exceed(?:ed|ing)|beat|(?:in line with|consistent with) (?:our |the )?(?:guidance|outlook|expectations)|(?:at|near|above|below|exceed\w*) the (?:high|low) end of our|ahead of (?:our|the)|versus (?:our|the)|we said|previously|last quarter we|had expected|original(?:ly)?)\b/i

const METRIC_WORDS: readonly { metric: Metric; re: RegExp }[] = [
  {
    metric: 'capex',
    re: /\b(?:capital expenditures?|cap ?ex|capital spending|capital investments?)\b/gi,
  },
  { metric: 'gross_margin', re: /\bgross margins?\b/gi },
  {
    metric: 'backlog',
    re: /\b(?:backlog|remaining performance obligations?|RPO)\b/g,
  },
  {
    metric: 'revenue',
    re: /\b(?:revenues?|net sales|(?<!and |& )sales(?! and marketing| tax| force| cycle| team))\b/gi,
  },
]

const SCALE: Readonly<Record<string, number>> = {
  trillion: 1e12,
  billion: 1e9,
  bn: 1e9,
  b: 1e9,
  million: 1e6,
  mn: 1e6,
  m: 1e6,
}
const NUM = String.raw`(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)`
// Transcripts set ranges with a non-breaking hyphen (U+2011) as often as a plain one.
const DASH = '[-‐‑‒–—−]'
const RANGE_SEP = `(?:${DASH}|to|and)`
const SCALE_WORD = String.raw`(trillion|billion|million|bn|mn|[bm])\b`
const MONEY_RANGE = new RegExp(
  String.raw`\$\s?${NUM}\s?(?:${SCALE_WORD})?\s?${RANGE_SEP}\s?(?:US)?\$?\s?${NUM}\s?${SCALE_WORD}`,
  'i',
)
const PLUS_MINUS = String.raw`(?:plus or\s+(?:m\s?inus|negative)|\+\s?\/\s?-|±)`
export const PLUS_MINUS_RE = new RegExp(PLUS_MINUS, 'i')
const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
}
const BAND_NUM = String.raw`(\d+(?:\.\d+)?|${Object.keys(WORD_NUMBERS).join('|')})`
const MONEY_BAND_PCT = new RegExp(
  String.raw`\$\s?${NUM}\s?${SCALE_WORD},?\s*${PLUS_MINUS}\s*${BAND_NUM}\s?(?:%|percent)`,
  'i',
)
const MONEY_BAND_ABS = new RegExp(
  String.raw`\$\s?${NUM}\s?${SCALE_WORD},?\s*${PLUS_MINUS}\s*\$\s?${NUM}\s?${SCALE_WORD}`,
  'i',
)
const MONEY_ONE = new RegExp(String.raw`\$\s?${NUM}\s?${SCALE_WORD}`, 'i')
const PCT = String.raw`${NUM}\s?(?:%|percent)`
const PCT_RANGE = new RegExp(String.raw`${NUM}\s?(?:%|percent)?\s?${RANGE_SEP}\s?${PCT}`, 'i')
const PCT_BAND = new RegExp(String.raw`${PCT},?\s*${PLUS_MINUS}\s*${NUM}\s?basis points`, 'i')
// "GAAP and non-GAAP gross margins are expected to be 63.3 percent and 63.5
// percent, respectively, plus or minus 50 basis points": two guides, not a range.
const RESPECTIVELY = new RegExp(
  String.raw`^${PCT}\s+and\s+${PCT},?\s+respectively(?:,?\s*${PLUS_MINUS}\s*${NUM}\s?basis points)?`,
  'i',
)
const PCT_ONE = new RegExp(PCT, 'i')

const num = (s: string) => WORD_NUMBERS[s.toLowerCase()] ?? Number(s.replace(/,/g, ''))
const scale = (s: string | undefined) => (s ? (SCALE[s.toLowerCase()] ?? 1) : 1)

interface Amount {
  unit: 'USD' | 'percent'
  low: number
  high: number
  bound: GuidanceBound
  at: number
  length: number
}

function boundBefore(text: string, at: number): GuidanceBound {
  const before = text.slice(Math.max(0, at - 30), at).toLowerCase()
  if (/(?:more than|greater than|over|exceed|at least|north of|above)\s*$/.test(before))
    return 'at_least'
  if (/(?:up to|less than|below|under|at most)\s*$/.test(before)) return 'at_most'
  return 'about'
}

/** The first amount in `text`, as the forms above. */
export function firstAmount(text: string): Amount | null {
  const found: Amount[] = []
  const add = (
    m: RegExpExecArray | null,
    f: (m: RegExpExecArray) => Omit<Amount, 'at' | 'length'> | null,
  ) => {
    const a = m && f(m)
    if (m && a) found.push({ ...a, at: m.index, length: m[0].length })
  }
  add(MONEY_BAND_PCT.exec(text), (m) => {
    const mid = num(m[1]!) * scale(m[2])
    const band = num(m[3]!) / 100
    return { unit: 'USD', low: mid * (1 - band), high: mid * (1 + band), bound: 'range' }
  })
  add(MONEY_BAND_ABS.exec(text), (m) => {
    const mid = num(m[1]!) * scale(m[2])
    const band = num(m[3]!) * scale(m[4])
    return { unit: 'USD', low: mid - band, high: mid + band, bound: 'range' }
  })
  add(MONEY_RANGE.exec(text), (m) => {
    const s = scale(m[4])
    const low = num(m[1]!) * (m[2] ? scale(m[2]) : s)
    const high = num(m[3]!) * s
    // "raising our revenue guide by $25 billion to $192 billion": the second is the guide.
    if (/\bby\s*$/i.test(text.slice(Math.max(0, m.index - 6), m.index)) && /\bto\b/.test(m[0])) {
      return { unit: 'USD', low: high, high, bound: 'about' }
    }
    return { unit: 'USD', low, high, bound: 'range' }
  })
  add(MONEY_ONE.exec(text), (m) => {
    const v = num(m[1]!) * scale(m[2])
    return { unit: 'USD', low: v, high: v, bound: boundBefore(text, m.index) }
  })
  add(PCT_BAND.exec(text), (m) => {
    const mid = num(m[1]!)
    const band = num(m[2]!) / 100
    return { unit: 'percent', low: mid - band, high: mid + band, bound: 'range' }
  })
  add(PCT_RANGE.exec(text), (m) => ({
    unit: 'percent',
    low: num(m[1]!),
    high: num(m[2]!),
    bound: 'range',
  }))
  add(PCT_ONE.exec(text), (m) => {
    // "in the mid-70% range" names no figure.
    if (/\b(?:mid|high|low|upper|lower)[- ]$/i.test(text.slice(Math.max(0, m.index - 6), m.index)))
      return null
    const v = num(m[1]!)
    return { unit: 'percent', low: v, high: v, bound: boundBefore(text, m.index) }
  })
  if (!found.length) return null
  // The earliest; at the same place, the longest form (a range over its first figure).
  found.sort((a, b) => a.at - b.at || b.length - a.length)
  const best = found[0]!
  // 8.2 × 1e9 is 8199999999.999999 in floating point: dollars to the dollar, percentages to 1e-4.
  const round = (v: number) => (best.unit === 'USD' ? Math.round(v) : Math.round(v * 1e4) / 1e4)
  const amount = { ...best, low: round(best.low), high: round(best.high) }
  return amount.high >= amount.low && amount.low > 0 ? amount : null
}

const ORDINAL: Readonly<Record<string, number>> = {
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
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

const year4 = (y: string) => {
  const n = Number(y.replace(/^'/, ''))
  return n < 100 ? 2000 + n : n
}

/** What stands before the base of a comparison ("compared with second quarter 2017"). */
const COMPARED =
  /\b(?:compared (?:with|to)|versus|vs\.?|relative to|against|from)\s+(?:the\s+)?(?:same\s+(?:period|quarter)\s+(?:of|in)\s+)?(?:the\s+)?$/i
/** A year inside a date ("ending June 30, 2018") is part of the date, not a period. */
const NOT_IN_DATE = String.raw`(?<!\b(?:${[...MONTHS, 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'].join('|')})\.?\s+\d{1,2},?\s+)`

/**
 * Every period a sentence names, with where, relative to the reported
 * quarter. A quarter with no year is the next one of that number, except the
 * reported quarter's own number, which names the quarter just reported.
 */
export function periodsIn(
  text: string,
  ctx: ExtractContext,
): { period: FiscalPeriod; at: number }[] {
  const { fyEndMonth, reported } = ctx
  const out: { period: FiscalPeriod; at: number }[] = []
  const quarterOf = (q: number, year: number | null) => {
    if (year !== null) return fiscalPeriod(fyEndMonth, year, q)
    if (q === reported.quarter) return reported
    const fy = q > reported.quarter! ? reported.fiscal_year : reported.fiscal_year + 1
    return fiscalPeriod(fyEndMonth, fy, q)
  }
  const taken: [number, number][] = []
  const each = (re: RegExp, f: (m: RegExpExecArray) => FiscalPeriod | null) => {
    for (const m of text.matchAll(re)) {
      const at = m.index
      if (taken.some(([a, b]) => at >= a && at < b)) continue
      const period = f(m)
      if (!period) continue
      taken.push([at, at + m[0].length])
      if (COMPARED.test(text.slice(Math.max(0, at - 40), at))) continue
      out.push({ period, at })
    }
  }
  each(
    /\b(first|second|third|fourth|1st|2nd|3rd|4th)[- ](?:fiscal[- ])?quarter\b(?:\s+of)?(?:\s+(?:fiscal\s+(?:year\s+)?|FY\s?)?('?\d{2}|20\d\d)\b)?/gi,
    (m) => quarterOf(ORDINAL[m[1]!.toLowerCase()]!, m[2] ? year4(m[2]) : null),
  )
  each(/\b(?:Q([1-4])|([1-4])Q)(?:\s?(?:FY|fiscal\s)?\s?('?\d{2}|20\d\d))?\b/g, (m) =>
    quarterOf(Number(m[1] ?? m[2]), m[3] ? year4(m[3]) : null),
  )
  each(new RegExp(String.raw`\b(${MONTHS.join('|')}) quarter\b`, 'gi'), (m) => {
    const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1
    let year = Number(reported.end.slice(0, 4))
    if (month <= Number(reported.end.slice(5, 7))) year++
    const p = quarterEnding(fyEndMonth, year, month)
    return p.quarter === null ? null : p
  })
  each(/\b(?:next|current|this|coming|upcoming) quarter\b|\bin the quarter\b/gi, () =>
    nextQuarter(fyEndMonth, reported),
  )
  each(/\b(?:fiscal\s+(?:year\s+)?|FY\s?)('?\d{2}|20\d\d)\b/gi, (m) =>
    fiscalPeriod(fyEndMonth, year4(m[1]!), null),
  )
  if (fyEndMonth === 12) {
    each(
      new RegExp(String.raw`${NOT_IN_DATE}\b(?:calendar\s+)?(20\d\d)\b(?!${DASH}\d)`, 'gi'),
      (m) => fiscalPeriod(fyEndMonth, Number(m[1]), null),
    )
  }
  each(/\b(?:full[- ]year|the (?:fiscal )?year|for the year|this year|annual)\b/gi, () =>
    fiscalPeriod(
      fyEndMonth,
      reported.quarter === 4 ? reported.fiscal_year + 1 : reported.fiscal_year,
      null,
    ),
  )
  return out
}

/** The period named nearest `anchor` (or first, with no anchor), or null. */
export function namedPeriod(text: string, ctx: ExtractContext, anchor = 0): FiscalPeriod | null {
  const found = periodsIn(text, ctx)
  if (!found.length) return null
  found.sort((a, b) => Math.abs(a.at - anchor) - Math.abs(b.at - anchor) || a.at - b.at)
  const best = found[0]!
  // "the full year 2026": a year named twice is still that year; a quarter
  // named with its year ("fourth quarter of fiscal 2026") was read as the quarter.
  return best.period
}

/** How many sentences back an outlook's period still governs a figure that names none. */
const OUTLOOK_REACH = 12

/** A figure with no period of its own takes the last figure's, this many sentences on at most. */
const CARRY_SENTENCES = 16

const RESTATED = /\b(?:remains? unchanged|unchanged from|reiterat\w*)\b/i

const OUTLOOK_CONTEXT =
  /\b(?:outlook|guidance|turning to|turn to|looking ahead|for the|moving to)\b/i

const STOP = new Set(
  (
    'the our total we for and of in to be expect expects expected that with its their quarter year ' +
    'fiscal full gaap non-gaap by driven from on at as is are will this next growth grow see deliver ' +
    'generate reach achieve approach exceed total be guidance guide anticipate now light these dynamics a an ' +
    'full-year largest your in'
  ).split(' '),
)
// Words before "revenue" that qualify it without naming a business line.
const GENERIC = new Set(
  (
    'outlook yoy long-term longer-term term metric guidance annual annualized quarterly net gross organic incremental additional sequential overall reported ' +
    'recognized deferred future such more less higher lower strong record related consolidated top-line'
  ).split(' '),
)

const SEGMENT_WORDS = new Set(
  (
    'data center cloud networking gaming client embedded automotive services product products hardware ' +
    'software server servers storage optical licensing iot handset non-handset ai'
  ).split(' '),
)

/** What stands before "revenue": a segment, an AI line, or nothing (total revenue). Null for a run rate. */
function revenueKind(
  text: string,
  at: number,
  end: number,
): { metric: Metric; segment: string | null } | null {
  const before = text.slice(Math.max(0, at - 60), at)
  if (/\b(?:run[- ]rate|ARR|recurring|average annual|annualized)\s*$/i.test(before)) return null
  // "cost of revenue", "cost of sales": a cost, not revenue.
  if (/\bcosts? of\s*$/i.test(before)) return null
  // A utility's "retail electricity sales" are kilowatt-hours, not revenue.
  if (
    /^sales$/i.test(text.slice(at, end)) &&
    /\b(?:electric(?:ity)?|retail|kwh|weather[- ]normalized|load|energy|gas|volumes?|units?)\s+$/i.test(
      before,
    )
  )
    return null
  const words = before
    .replace(/[•▪●·]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(-4)
  const kept: string[] = []
  for (let i = words.length - 1; i >= 0; i--) {
    const raw = words[i]!
    const w = raw.replace(/[;:()“”"]/g, '')
    if (raw.endsWith(',') && kept.length + 1 < words.length - i) break
    if (raw.endsWith(',') || !w || STOP.has(w.toLowerCase()) || /\d|%|\$/.test(w)) break
    if (/ing$/i.test(w) || (/ed$/.test(w) && !/^[A-Z]/.test(w))) break
    // A heading in capitals ("OUTLOOK", "ACCELERATING"); segment acronyms are short (QCT, DCAI).
    if (/^[A-Z-]{6,}$/.test(w)) break
    if (GENERIC.has(w.toLowerCase())) break
    // A business line is a name (Data Center, QCT, ISG) or one of the common lowercase ones.
    if (!/[A-Z]/.test(w) && !SEGMENT_WORDS.has(w.toLowerCase())) break
    kept.unshift(w)
  }
  const phrase = kept.join(' ').replace(/\s+segment$/i, '')
  if (/\bAI\b/.test(phrase)) return { metric: 'ai_revenue', segment: phrase }
  if (phrase && !/^segments?$/i.test(phrase)) return { metric: 'segment_revenue', segment: phrase }
  // "revenue at Electrification", "revenues in Data Center"
  const after =
    /^\s+(?:at|in|for|from)\s+(?:our\s+)?((?:[A-Z][\w&-]*)(?:\s+(?:and\s+)?[A-Z][\w&-]*){0,3})/.exec(
      text.slice(end),
    )
  if (after && !/^(?:Q[1-4]|The|Our|Fiscal|FY)/.test(after[1]!)) {
    return { metric: 'segment_revenue', segment: after[1]! }
  }
  // "In cloud and AI, we expect revenue to grow 60% to 72%"
  // A comma lead names what follows ("In devices and consumer, ..."); one
  // without a comma must be a name ("In Productivity and Business Processes we ...").
  const comma = /^(?:In|For|At|Within)\s+([A-Za-z][\w&\s-]{1,40}?),\s/.exec(text)
  const bare =
    /^(?:In|For|At|Within)\s+([A-Z][\w&-]*(?:\s+(?:[A-Z][\w&-]*|and))*?)\s+(?=we\b|our\b)/.exec(
      text,
    )
  const lead = comma ?? bare
  if (
    lead &&
    at > lead[0].length &&
    !/\b(?:quarter|year|fiscal|total|summary|addition|Q[1-4]|guidance|outlook|light of|terms of|order to|short|particular|general|example|instance|context|closing|aggregate|other words|turn|sum|the)\b|^\d/i.test(
      lead[1]!,
    ) &&
    (comma ||
      lead[1]!
        .split(/\s+/)
        .every((w) => /[A-Z]/.test(w) || SEGMENT_WORDS.has(w.toLowerCase()) || w === 'and'))
  ) {
    return /\bAI\b/.test(lead[1]!)
      ? { metric: 'ai_revenue', segment: lead[1]! }
      : { metric: 'segment_revenue', segment: lead[1]! }
  }
  return { metric: 'revenue', segment: null }
}

/** An amount further than this after its metric word belongs to something else. */
const AMOUNT_REACH = 110
// Another measure named between the metric and the amount takes the amount.
const DISTRACTOR =
  /\b(?:market|TAM|addressable|EPS|earnings per share|EBITDA|EBT|operating (?:income|expenses?|margin)|net income|equity|dividend|tax|share count|interest|free cash flow|cash flow|opex|cost)\b/i
// What follows an amount that makes it a delta, a run rate or a mix rather than the level.
const NOT_LEVEL =
  /^\s*(?:run[- ]rate|annualized|above|below|higher than|lower than|more than (?:last|the prior)|ahead of|of (?:total )?(?:revenue|sales))/i
const AMOUNT_BEFORE = new RegExp(
  String.raw`\$\s?${NUM}\s?${SCALE_WORD}\s+(?:in|of)\s+((?:[\w-]+\s+)?)$`,
  'i',
)

/** The amount a metric mention states: after it, or just before it ("$40 billion in revenues"). */
function amountFor(
  text: string,
  mention: { at: number; end: number },
  clauseEnd: number,
  qualified: boolean,
): { amount: Amount; clause: string } | null {
  // Only a qualified line takes an amount from before it: "$40 billion in
  // non-handset revenues". Before a bare "revenue" it is usually some other figure's.
  const ahead = AMOUNT_BEFORE.exec(text.slice(Math.max(0, mention.at - 40), mention.at))
  const before = ahead && (qualified || /^total\s/i.test(ahead[3] ?? '')) ? ahead : null
  if (before) {
    const local = firstAmount(before[0])
    if (local) return { amount: local, clause: before[0] }
  }
  const clause = text.slice(mention.end, clauseEnd)
  const amount = firstAmount(clause)
  if (!amount || amount.at > AMOUNT_REACH) return null
  if (DISTRACTOR.test(clause.slice(0, amount.at))) return null
  // "increasing from $3 billion", "raised by $6.5 billion": a prior figure or a change, not the level.
  if (
    /\b(?:from|by)\s*$/i.test(clause.slice(Math.max(0, amount.at - 8), amount.at)) &&
    !/\bto\b/.test(clause.slice(amount.at, amount.at + amount.length))
  )
    return null
  const rest = clause.slice(amount.at + amount.length)
  if (NOT_LEVEL.test(rest)) return null
  // "$150 million of QTL revenues", "16-17% non-GAAP operating margin": the figure is the next measure's.
  if (
    /^\s+(?:in|of)\s+(?:[\w-]+\s+){0,2}(?:revenues?|sales)\b/i.test(rest) ||
    /^\s*(?:non-GAAP\s+|GAAP\s+|adjusted\s+)?(?:operating|EBITDA|net income|tax)\b/i.test(rest)
  )
    return null
  return { amount, clause }
}

/** At most QUOTE_MAX_WORDS words of the sentence, around `at`, with an ellipsis where it is cut. */
export function quoteOf(sentence: string, at: number): string {
  const words = sentence.split(/\s+/)
  if (words.length <= QUOTE_MAX_WORDS) return sentence
  let pos = 0
  let index = 0
  for (let i = 0; i < words.length; i++) {
    if (pos >= at) {
      index = i
      break
    }
    pos += words[i]!.length + 1
    index = i
  }
  const from = Math.max(0, Math.min(index - 6, words.length - QUOTE_MAX_WORDS))
  const cut = words.slice(from, from + QUOTE_MAX_WORDS).join(' ')
  return `${from > 0 ? '…' : ''}${cut}${from + QUOTE_MAX_WORDS < words.length ? '…' : ''}`
}

const isQuestion = (s: string) => s.trim().endsWith('?')

/** How many sentences after an outlook's lead-in its list runs, at most. */
const LIST_REACH = 14
/** A sentence longer than this is prose, and ends a list. */
const LIST_ITEM_MAX = 300
const LEAD =
  /:\s*$|\bthe following\b|^(?:[\w&'’-]+\s+){0,6}(?:business\s+|financial\s+)?(?:outlook|guidance)(?:\s+summary)?(?:\s*\(\+\))?:?$/i
const NOT_LEAD = /\b(?:results?|compared|versus|reconciliation of|actual)\b/i
const LABEL =
  /^(?:(?:GAAP|non-GAAP)\s+)?(?:total\s+|net\s+)?(?:revenues?|net sales|sales|gross margins?(?:\s*%)?|capital expenditures|capex)\s*\*?(?:\s*\(\d\))?\s*:?$/i

/** A cell that is only an amount ("$4.8B - $5.6B", "~25%"). */
function amountOnly(text: string): boolean {
  if (text.length > 48) return false
  const a = firstAmount(text)
  if (!a) return false
  return (
    text
      .slice(0, a.at)
      .concat(text.slice(a.at + a.length))
      .replace(/[~≈()*\d\s.,]/g, '').length <= 3
  )
}

interface Item extends DocSentence {
  /** Under an outlook's lead-in: forward-looking without saying so again. */
  listed: boolean
  /** Where the list's lead-in is, for its period. */
  lead: number | null
}

/**
 * The document's sentences with outlook lists marked, and each table row
 * under one ("Revenues", "$5.4B", "$4.8B - $5.6B") joined into one sentence:
 * the label and the row's last amount, which is the guidance column.
 */
export function outlookItems(sentences: readonly DocSentence[]): Item[] {
  const out: Item[] = []
  let lead: number | null = null
  let until = -1
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!
    const text = s.text
    if (text.length > LIST_ITEM_MAX) until = -1
    const inList = i <= until
    if (
      text.length <= 200 &&
      (FORWARD.test(text) || /\b(?:outlook|guidance)\b/i.test(text)) &&
      LEAD.test(text) &&
      !NOT_LEAD.test(text) &&
      !PAST.test(text)
    ) {
      out.push({ ...s, listed: false, lead: null })
      lead = out.length - 1
      until = i + LIST_REACH
      continue
    }
    if (inList && LABEL.test(text)) {
      let j = i + 1
      while (j < sentences.length && j <= i + 3 && amountOnly(sentences[j]!.text)) j++
      if (j > i + 1) {
        // "$16.3 billion" then "+/- $500 million": the band belongs to the cell before it.
        let from = j - 1
        if (from > i + 1 && /^\s*(?:plus or|\+\s?\/\s?-|±)/i.test(sentences[from]!.text)) from--
        const cells = sentences
          .slice(from, j)
          .map((c) => c.text)
          .join(' ')
        out.push({
          ...s,
          text: `${text.replace(/[\s:*]+$/, '')}${from > i + 1 ? ' … ' : ' '}${cells}`,
          listed: true,
          lead,
        })
        i = j - 1
        continue
      }
    }
    out.push({ ...s, listed: inList && !PAST.test(text), lead: inList ? lead : null })
  }
  return out
}

/** "GAAP and non-GAAP … X% and Y%, respectively": the two guides, by basis, or null. */
function respectively(
  text: string,
  clause: string,
  amount: Amount,
): { basis: 'gaap' | 'non_gaap'; amount: Amount }[] | null {
  if (amount.unit !== 'percent' || !/\bGAAP and non[\s-]*GAAP\b/i.test(text)) return null
  const m = RESPECTIVELY.exec(clause.slice(amount.at))
  if (!m) return null
  const band = m[3] ? num(m[3]) / 100 : 0
  const at = (v: number): Amount => ({
    ...amount,
    low: Math.round((v - band) * 1e4) / 1e4,
    high: Math.round((v + band) * 1e4) / 1e4,
    bound: band ? 'range' : 'about',
  })
  return [
    { basis: 'gaap', amount: at(num(m[1]!)) },
    { basis: 'non_gaap', amount: at(num(m[2]!)) },
  ]
}

const TWO_COLUMNS = /\b(?:Q[1-4]|FY)\s?'?\d{2,4}\s+(?:Q[1-4]|FY)\s?'?\d{2,4}\b/

/** A goal over several years is not one period's guidance. */
const MULTI_YEAR = /\bCAGR\b|compound annual|\b(?:two|three|four|five|\d)-year\b|multi-year/i

/** Every statement in a document's sentences, in order, without repeats. */
export function extractStatements(
  sentences: readonly DocSentence[],
  ctx: ExtractContext,
): Statement[] {
  const out: Statement[] = []
  const seen = new Set<string>()
  const allowed = ctx.speakers ? new Set(ctx.speakers.map((s) => s.toLowerCase())) : null
  let last: { period: FiscalPeriod; at: number } | null = null
  const items = outlookItems(sentences)
  for (let i = 0; i < items.length; i++) {
    const s = items[i]!
    const text = s.text
    // A sentence back on the quarter just reported ends any outlook being carried.
    if (
      last &&
      PAST.test(text) &&
      periodsIn(text, ctx).some((p) => p.period.end <= ctx.reported.end)
    )
      last = null
    if (text.length > 600 || isQuestion(text)) continue
    if (allowed && (!s.speaker || !allowed.has(s.speaker.toLowerCase()))) continue
    if ((!FORWARD.test(text) && !s.listed) || PAST.test(text)) continue
    if (MULTI_YEAR.test(text)) continue
    // A slide's column headers ("Q2 2021 FY 2021 Revenue ~$3.6 Billion"): which column is whose isn't known.
    if (TWO_COLUMNS.test(text)) continue
    // An analyst restating the guide in a transcript without speaker labels.
    if (
      /\byour (?:guide|guidance|outlook|forecast)\b|\byou (?:guided|said|mentioned)\b/i.test(text)
    )
      continue
    const mentions = METRIC_WORDS.flatMap(({ metric, re }) =>
      [...text.matchAll(re)].map((m) => ({ metric, at: m.index, end: m.index + m[0].length })),
    ).sort((a, b) => a.at - b.at)
    for (let k = 0; k < mentions.length; k++) {
      const mention = mentions[k]!
      let metric = mention.metric
      let segment: string | null = null
      // "Operating Expenses/Revenue %": a ratio to revenue, not revenue.
      if (text[mention.at - 1] === '/') continue
      // A backlog stated before "we expect" is the backlog now, not a guide.
      if (metric === 'backlog' && !s.listed && (FORWARD.exec(text)?.index ?? 0) > mention.at)
        continue
      // Growth or maintenance capex is part of the total the filings print.
      if (
        metric === 'capex' &&
        /\b(?:growth|maintenance|sustaining|expansion)\s+$/i.test(
          text.slice(Math.max(0, mention.at - 14), mention.at),
        )
      )
        continue
      if (metric === 'revenue') {
        const kind = revenueKind(text, mention.at, mention.end)
        if (!kind) continue
        ;({ metric, segment } = kind)
      }
      const found = amountFor(text, mention, mentions[k + 1]?.at ?? text.length, segment !== null)
      if (!found) continue
      const { amount, clause } = found
      const amountText = clause.slice(amount.at, amount.at + amount.length)
      let unit: GuidanceUnit = amount.unit
      if (amount.unit === 'percent') {
        if (metric === 'gross_margin') unit = 'percent'
        else if (metric === 'capex' || metric === 'backlog') continue
        else {
          const between = clause.slice(0, amount.at)
          if (!/\b(?:grow|growth|increase|up|rise)\b/i.test(between)) continue
          if (/\b(?:decline|down)\b/i.test(between)) continue
          unit = /sequential/i.test(text) ? 'growth_qoq' : 'growth_yoy'
        }
      } else if (metric === 'gross_margin') continue
      // A multi-year plan or a cumulative total is not one period's capex.
      if (
        metric === 'capex' &&
        /\b(?:five|\d)-year|multi-year|cumulative|through 20\d\d|over the next/i.test(text)
      )
        continue
      // The period named nearest the figure wins over one elsewhere in the sentence.
      let period = namedPeriod(text, ctx, mention.at)
      const ahead = (p: FiscalPeriod | null) => (p && p.end > ctx.reported.end ? p : null)
      for (let back = 1; !period && back <= OUTLOOK_REACH && i - back >= 0; back++) {
        const prev = items[i - back]!.text
        const inList = s.lead !== null && i - back >= s.lead
        // "Our full year outlook remains unchanged": a guide restated in passing sets no period for what follows.
        if (RESTATED.test(prev)) continue
        if (inList || OUTLOOK_CONTEXT.test(prev)) {
          period = ahead(periodsIn(prev, ctx).find((p) => ahead(p.period))?.period ?? null)
        }
      }
      // An outlook read figure by figure: the period of the last one a few sentences back.
      if (!period && last && i - last.at <= CARRY_SENTENCES) period = last.period
      if (!period && PLUS_MINUS_RE.test(amountText))
        period = nextQuarter(ctx.fyEndMonth, ctx.reported)
      // Capex given with no period is the fiscal year's: no one guides a quarter's unnamed.
      if (!period && metric === 'capex' && amount.unit === 'USD' && amount.high >= 1e9) {
        const q = ctx.reported.quarter!
        period = fiscalPeriod(
          ctx.fyEndMonth,
          q === 4 ? ctx.reported.fiscal_year + 1 : ctx.reported.fiscal_year,
          null,
        )
      }
      if (!period || period.end <= ctx.reported.end) continue
      // Growth stated for a quarter without saying against what isn't placed.
      if (
        unit === 'growth_yoy' &&
        period.quarter !== null &&
        !/year[- ]over[- ]year|year[- ]on[- ]year|\byoy\b|from (?:a|the) year/i.test(text)
      )
        continue
      // "GAAP revenue of $77.0 billion and non-GAAP revenue of $72.5 billion": each its own.
      const just = text.slice(Math.max(0, mention.at - 24), mention.at)
      const local = /\bGAAP and non[\s-]*GAAP\s+$/i.test(just)
        ? 'gaap'
        : /\bnon[\s-]*GAAP\s+$/i.test(just)
          ? 'non_gaap'
          : /\bGAAP\s+$/.test(just)
            ? 'gaap'
            : null
      // A margin's basis may be stated anywhere in its sentence; a dollar figure's only
      // just before it, since "non-GAAP EPS" later in the sentence says nothing of revenue.
      const sentenceBasis = /\bGAAP and non[\s-]*GAAP\b/i.test(text)
        ? 'gaap'
        : /\bnon[\s-]*GAAP\b/i.test(text)
          ? 'non_gaap'
          : /\bGAAP\b/.test(text)
            ? 'gaap'
            : null
      const basis = local ?? (metric === 'gross_margin' ? sentenceBasis : null)
      const variants = respectively(text, clause, amount) ?? [{ basis, amount }]
      for (const v of variants) {
        const key = [
          metric,
          segment,
          variants.length > 1 ? v.basis : null,
          unit,
          period.fiscal_year,
          period.quarter,
          v.amount.low,
          v.amount.high,
        ].join('|')
        if (seen.has(key)) continue
        seen.add(key)
        last = { period, at: i }
        out.push({
          metric,
          segment,
          basis: v.basis,
          unit,
          bound: v.amount.bound,
          low: v.amount.low,
          high: v.amount.high,
          period,
          quote: quoteOf(text, mention.at),
          sentence: text,
          page: s.page,
          at_ms: s.at_ms,
          speaker: s.speaker,
        })
      }
    }
  }
  return out
}
