// One quotable paragraph per lab (a SKU's is the pricing layer's price-ledes.ts), built
// from the numbers the page already renders. Answer engines quote a sentence, not a tile
// grid, so the header figures also appear once as plain text naming the lab, the number,
// the unit and the date. Nothing here is a figure the page doesn't show beside it; a
// missing value drops its sentence instead of a placeholder.

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
