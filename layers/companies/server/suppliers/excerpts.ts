// What the judge is shown of a supplier's document, and the checks a passage
// it sends back must pass. Pure, so layers/companies/test/suppliers-ingest.test.ts
// runs them on captured filings.

import type { SupplierFigure } from '../../shared/utils/suppliers'
import { amountsIn } from '#layers/core/server/pipeline/amounts'
import { COUNTERPARTIES } from './filers'

/** Characters of excerpts offered per document, and the run around each hit. */
export const EXCERPT_CHARS = 24_000
const WINDOW = 700

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The spellings searched in one filer's documents: every counterparty but itself. */
function namePattern(ticker: string): RegExp {
  const spellings = COUNTERPARTIES.filter((c) => c.self !== ticker).flatMap((c) => c.spellings)
  return new RegExp(`\\b(?:${spellings.map(escape).join('|')})\\b`, 'g')
}

/** A share put on a customer the document may not name. */
const CONCENTRATION =
  /\b(?:Customer [A-H]\b|(?:largest|major|significant) customers?\b|customers? (?:that )?accounted for|accounted for (?:approximately |about )?\d+(?:\.\d+)?\s?%)/g

/** A figure a passage can carry: money, a share, shares or warrants, power. */
const FIGURE = /\$\s?\d|\d\s?%|\bpercent\b|\bwarrants?\b|\bgigawatts?\b|\bGW\b/i

/**
 * Runs of the text around each counterparty name and each customer share,
 * merged where they overlap, those that state a figure first, up to
 * EXCERPT_CHARS. Each run is a verbatim slice of `text`.
 */
export function supplierExcerpts(text: string, ticker: string): string[] {
  const hits = [
    ...[...text.matchAll(namePattern(ticker))].map((m) => m.index),
    ...[...text.matchAll(CONCENTRATION)].map((m) => m.index),
  ].sort((a, b) => a - b)
  const runs: [number, number][] = []
  for (const at of hits) {
    const start = Math.max(0, at - WINDOW / 2)
    const end = Math.min(text.length, at + WINDOW / 2)
    const last = runs.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else runs.push([start, end])
  }
  const slices = runs.map(([s, e]) => text.slice(s, e))
  const ranked = [...slices.filter((s) => FIGURE.test(s)), ...slices.filter((s) => !FIGURE.test(s))]
  const out: string[] = []
  let used = 0
  for (const s of ranked) {
    if (used + s.length > EXCERPT_CHARS) continue
    out.push(s)
    used += s.length
  }
  return out
}

const SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 }

/** Every number the quote writes, with what follows it, scaled by a word after it. */
function numbersIn(quote: string): { value: number; raw: number; after: string }[] {
  const out: { value: number; raw: number; after: string }[] = []
  for (const m of quote.matchAll(
    /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(thousand|million|billion|trillion)\b)?/gi,
  )) {
    const raw = Number(`${m[1]!.replace(/,/g, '')}${m[2] ?? ''}`)
    const scale = m[3] ? SCALE[m[3].toLowerCase()]! : 1
    out.push({
      value: raw * scale,
      raw,
      after: quote.slice(m.index + m[0].length, m.index + m[0].length + 12),
    })
  }
  return out
}

const same = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-9

/** Whether the quote writes the figure, in the unit the figure claims. */
export function figureWritten(quote: string, f: SupplierFigure): boolean {
  switch (f.unit) {
    case 'usd':
      return amountsIn(quote).some((a) => a.currency === 'USD' && same(a.value, f.value))
    case 'pct_revenue':
    case 'pct_revenue_combined':
    case 'pct_receivables':
    case 'pct_backlog':
      return numbersIn(quote).some((n) => same(n.raw, f.value) && /^\s?(%|percent)/i.test(n.after))
    case 'gw':
      return numbersIn(quote).some(
        (n) => same(n.raw, f.value) && /^\s?(GW|gigawatt)/i.test(n.after),
      )
    case 'shares':
      return numbersIn(quote).some((n) => same(n.value, f.value))
  }
}
