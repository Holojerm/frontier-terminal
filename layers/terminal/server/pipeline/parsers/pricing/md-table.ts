// Minimal markdown pipe-table reader shared by the vendor .md parsers.
// Deterministic: pure string work, document order preserved; callers sort
// their output rows by stable keys.

const rowCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

const isSeparator = (cells: string[]): boolean => cells.every((c) => /^:?-{3,}:?$/.test(c))

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
    const cells = rowCells(lines[i]!)
    if (!isSeparator(cells)) rows.push(cells)
  }
  return rows
}

/** Every pipe table between the given heading line and the next heading of
 * any level, in document order, each shaped as tableAfterHeading returns
 * it. Throws on a missing heading or a section with no table. */
export function tablesUnderHeading(text: string, heading: string): string[][][] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) throw new Error(`heading not found: ${heading}`)

  const tables: string[][][] = []
  let current: string[][] | null = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (/^#{1,6}\s/.test(line)) break
    if (!line.startsWith('|')) {
      current = null
      continue
    }
    const cells = rowCells(line)
    if (isSeparator(cells)) continue
    if (!current) tables.push((current = []))
    current.push(cells)
  }
  if (tables.length === 0) throw new Error(`no table under heading: ${heading}`)
  return tables
}

/** "$12.50 / MTok" | "$0.80" -> 12.5 | 0.8. Throws on anything that does
 * not literally print a leading dollar amount (price honesty: no guessing). */
export function usdAmount(cell: string): number {
  const m = cell.match(/^\$(\d+(?:\.\d+)?)/)
  if (!m) throw new Error(`cell does not print a USD amount: ${cell}`)
  return Number(m[1])
}

const MONTHS: Record<string, string> = {
  January: '01',
  February: '02',
  March: '03',
  April: '04',
  May: '05',
  June: '06',
  July: '07',
  August: '08',
  September: '09',
  October: '10',
  November: '11',
  December: '12',
}

/** "December 31, 2026" -> "2026-12-31"; null for anything else. */
export function isoDate(printed: string): string | null {
  const m = printed.match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/)
  if (!m) return null
  const month = MONTHS[m[1]!]
  if (!month) return null
  return `${m[3]}-${month}-${m[2]!.padStart(2, '0')}`
}
