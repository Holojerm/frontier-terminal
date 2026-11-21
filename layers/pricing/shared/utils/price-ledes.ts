// One quotable paragraph per SKU, built from the numbers its page already
// renders: answer engines quote a sentence, not a chart. Nothing here is a
// figure the page doesn't show beside it; a missing value drops the sentence.

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
