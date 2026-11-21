// Amounts of money in a line of text: "$30 billion", "€11.7bn", "USD 518
// billion", "30 billion dollars", read the same way by the press figures, the
// filing review and the supplier excerpts.
//
// Dependency-free: scripts/gdelt-search.ts imports the figures reader, and so
// this file, without `bun install`.

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
