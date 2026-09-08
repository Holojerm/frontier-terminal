// Minimal markdown pipe-table reader shared by the vendor .md parsers.
// Deterministic: pure string work, document order preserved; callers sort
// their output rows by stable keys.

/** Cells of the first pipe table after the given heading line. Header row
 * included; the `---` separator row is dropped. Throws if the heading or a
 * table under it is missing — a vanished table must fail loudly, not emit
 * an empty (and silently wrong) snapshot. */
export function tableAfterHeading(text: string, heading: string): string[][] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) throw new Error(`heading not found: ${heading}`)

  let i = start + 1
  while (i < lines.length && !lines[i]!.trim().startsWith('|')) {
    // A new heading before any table means the table is gone.
    if (/^#{1,6}\s/.test(lines[i]!.trim())) throw new Error(`no table under heading: ${heading}`)
    i++
  }
  if (i >= lines.length) throw new Error(`no table under heading: ${heading}`)

  const rows: string[][] = []
  for (; i < lines.length && lines[i]!.trim().startsWith('|'); i++) {
    const cells = lines[i]!.trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    const isSeparator = cells.every((c) => /^:?-{3,}:?$/.test(c))
    if (!isSeparator) rows.push(cells)
  }
  return rows
}

/** "$12.50 / MTok" | "$0.80" -> 12.5 | 0.8. Throws on anything that does
 * not literally print a leading dollar amount (price honesty: no guessing). */
export function usdAmount(cell: string): number {
  const m = cell.match(/^\$(\d+(?:\.\d+)?)/)
  if (!m) throw new Error(`cell does not print a USD amount: ${cell}`)
  return Number(m[1])
}
