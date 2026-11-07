// Reported figures: lab revenue, valuations and funding rounds as the press
// headlines them, read from the same GDELT GKG files as the track record
// (../track-record/gkg.ts). A headline is kept when it names a private lab we
// track, states an amount of money, and uses a financial word. The judge then
// says which lab, metric and basis each amount is (review.ts), and the Worker
// keeps a label only when its amount and lab are in the headline.
//
// Dependency-free: scripts/gdelt-search.ts imports it without `bun install`,
// and the Worker re-runs the same match on every posted row before keeping it.

/** The private labs whose financials only the press reports. Public parents file their own. */
export const REPORTED_LABS = [
  'openai',
  'anthropic',
  'xai',
  'mistral',
  'deepseek',
  'moonshot',
] as const
export type ReportedLab = (typeof REPORTED_LABS)[number]

// xAI is case-sensitive: "xai" and "XAI" are other things in headlines.
const LAB_PATTERNS: Readonly<Record<ReportedLab, RegExp>> = {
  openai: /\bOpenAI\b/i,
  anthropic: /\bAnthropic\b/i,
  xai: /\bxAI\b/,
  mistral: /\bMistral\b/i,
  deepseek: /\bDeepSeek\b/i,
  moonshot: /\bMoonshot(?: AI)?\b/i,
}

/** The labs a headline names, in REPORTED_LABS order. */
export function labsIn(title: string): ReportedLab[] {
  return REPORTED_LABS.filter((lab) => LAB_PATTERNS[lab].test(title))
}

export type Currency = 'USD' | 'EUR'

export interface Amount {
  /** The amount as the headline writes it, e.g. "$30 billion" or "€11.7bn". */
  text: string
  currency: Currency
  /** In units of the currency. */
  value: number
}

const SCALE: Readonly<Record<string, number>> = {
  trillion: 1e12,
  tn: 1e12,
  t: 1e12,
  billion: 1e9,
  bn: 1e9,
  b: 1e9,
  million: 1e6,
  mn: 1e6,
  mln: 1e6,
  m: 1e6,
}

// "$30 billion", "US$1.2bn", "€11.7B", "$500M", "USD 518 billion", "$40,000,000,000".
const SYMBOL_AMOUNT =
  /(US\$|\$|€|\bUSD\s|\bEUR\s)\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s?(trillion|billion|million|mln|tn|bn|mn|[tbm])\b)?/gi
// "30 billion dollars", "2 billion euros".
const WORD_AMOUNT = /\b(\d+(?:\.\d+)?)\s?(trillion|billion|million)\s(dollars|euros)\b/gi

/** An amount smaller than this is a price or a salary, never a lab figure. */
export const MIN_AMOUNT = 1e6

/** Every amount of money in a headline, in the order written, a million or more. */
export function amountsIn(title: string): Amount[] {
  const out: (Amount & { at: number })[] = []
  for (const m of title.matchAll(SYMBOL_AMOUNT)) {
    const scale = m[3] ? SCALE[m[3].toLowerCase()]! : 1
    const value = Number(m[2]!.replace(/,/g, '')) * scale
    if (value < MIN_AMOUNT) continue
    const currency = m[1] === '€' || /^EUR/i.test(m[1]!) ? 'EUR' : 'USD'
    out.push({ text: m[0], currency, value, at: m.index })
  }
  for (const m of title.matchAll(WORD_AMOUNT)) {
    const value = Number(m[1]) * SCALE[m[2]!.toLowerCase()]!
    if (value < MIN_AMOUNT) continue
    const currency = m[3]!.toLowerCase() === 'euros' ? 'EUR' : 'USD'
    out.push({ text: m[0], currency, value, at: m.index })
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...a }) => a)
}

// Words that make an amount next to a lab's name a financial figure. Broad on
// purpose: the judge drops a headline that states none (a gift, a debt deal).
const FIGURE_WORDS =
  /\b(revenues?|sales|run[- ]rate|annuali[sz]ed|ARR|valuations?|valued|valuing|worth|raises?|raised|raising|fundraise|fundraising|funding|financing|round|tender|share sale|secondary|investors?|investment|backs|backed|acquires|acquired|acquisition|bought|buys|forecasts?|projects|projected|projections?|expects|targets?|sees)\b/i

export interface FigureHeadline {
  labs: ReportedLab[]
  amounts: Amount[]
}

/** A headline worth a judge's reading, or null: a tracked lab, an amount of money, and a financial word. */
export function figureHeadline(title: string): FigureHeadline | null {
  const labs = labsIn(title)
  if (labs.length === 0 || !FIGURE_WORDS.test(title)) return null
  const amounts = amountsIn(title)
  return amounts.length ? { labs, amounts } : null
}
