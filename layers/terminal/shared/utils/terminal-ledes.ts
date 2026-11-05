// One quotable paragraph per lab and per SKU, built from the numbers the page
// already renders. Answer engines quote a sentence, not a tile grid, so the
// figures in the header also appear once as plain text that names the lab, the
// number, the unit, and the date. Nothing here is a figure the page doesn't
// show beside it; a missing value drops its sentence instead of a placeholder.

import { compactUsd, count, money, periodLabel, sharePct } from './terminal-format'
import { labName } from './terminal-labs'
import type { LabSummary } from './terminal-lab-summary'
import type { PriceHistoryData, PricePoint } from './terminal-types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'Sep 22, 2026' in UTC. A quoted sentence needs the year a stamp leaves out. */
export function longDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

/** '$4.00 per million input tokens and $20.00 per million output tokens'; null when neither is set. */
function pricePhrase(input: number | null, output: number | null): string | null {
  const parts = [
    input === null ? null : `${money(input)} per million input tokens`,
    output === null ? null : `${money(output)} per million output tokens`,
  ].filter((p): p is string => p !== null)
  return parts.length ? parts.join(' and ') : null
}

export function labLede(s: LabSummary): string | null {
  const sentences: string[] = []
  const subject = () => (sentences.length ? 'It' : s.display)

  const row = s.flagship?.priced ? s.flagship.row : null
  const price = row ? pricePhrase(row.input_per_mtok, row.output_per_mtok) : null
  if (row && price) {
    sentences.push(`${s.display}’s flagship API model is ${row.model_slug}, at ${price}.`)
  }

  // Only the lab's own filing. A parent's revenue is a different company's number.
  const rev = s.revenue.newest
  if (rev && s.revenue.view?.disclosure === 'issuer') {
    sentences.push(
      `${subject()} reported ${compactUsd(rev.val)} in revenue for the ${periodLabel(rev.days)} ending ${rev.end} (${rev.form} filed with the SEC).`,
    )
  }

  if (s.demand?.share != null) {
    sentences.push(
      `${subject()} had ${sharePct(s.demand.share)} of all OpenRouter tokens over the last 7 days.`,
    )
  }

  if (s.hiring.now !== null) {
    sentences.push(
      `${subject()} lists ${count(s.hiring.now)} open role${s.hiring.now === 1 ? '' : 's'}.`,
    )
  }

  return sentences.length ? sentences.join(' ') : null
}

const isPriced = (p: PricePoint) =>
  p.kind !== 'removed' && (p.input_per_mtok !== null || p.output_per_mtok !== null)

const samePrice = (a: PricePoint, b: PricePoint) =>
  a.input_per_mtok === b.input_per_mtok && a.output_per_mtok === b.output_per_mtok

export function skuLede(h: PriceHistoryData): string | null {
  const priced = h.points.filter(isPriced)
  const last = priced[priced.length - 1]
  if (!last) return null
  const price = pricePhrase(last.input_per_mtok, last.output_per_mtok)
  if (!price) return null

  const lab = labName(h.provider)
  const name = `${h.model_slug}${h.tier ? ` (${h.tier})` : ''}`

  const removed = h.points.findLast((p) => p.kind === 'removed')
  if (h.removed && removed) {
    return `${lab} delisted ${name} on ${longDate(removed.at)}. Its last listed price was ${price}.`
  }

  // The start of the run of observations at today's price is when it took
  // effect, but only a listing or revision we saw happen dates it exactly.
  // Any other point (first seen, archived, current) only bounds it from below.
  let start = last
  for (let i = priced.length - 2; i >= 0 && samePrice(priced[i]!, last); i--) start = priced[i]!
  const since =
    start.kind === 'added' || start.kind === 'modified'
      ? `since ${longDate(start.at)}`
      : `since at least ${longDate(start.at)}`

  return `${lab} lists ${name} at ${price}. That price has held ${since}.`
}
