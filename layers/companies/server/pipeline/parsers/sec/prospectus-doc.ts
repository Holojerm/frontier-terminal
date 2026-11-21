import { cellText, decodeEntities, tableRows } from './filing-index'

// Reading a registration document's prose, not just its tables. EDGAR's
// rendering of a Workiva prospectus positions every printed line absolutely:
// each line is its own `<div style="…line-height:…">` holding `<font>` runs,
// so a paragraph is a run of line divs and a heading is a run whose every
// font is bold italic. This module turns the document into those lines, with
// their byte offsets, so a parser can find an anchor sentence in the text and
// then read the `<table>` that follows it in the bytes.

export interface DocLine {
  /** Byte offset of the line's `<div>`. */
  at: number
  /** Offset one past its closing `</div>`. */
  end: number
  text: string
  /** Every non-blank run is bold. */
  bold: boolean
  /** Every non-blank run is italic. */
  italic: boolean
  /** The largest font size among its non-blank runs, in points; 0 when none is stated. */
  size: number
}

const LINE = /<div style="[^"]*line-height:[^"]*">([\s\S]*?)<\/div>/g
const TOKEN = /<(\/?)([a-zA-Z]+)\b([^>]*)>|([^<]+)/g

const WEIGHT = /(?:^|;)\s*font-weight:\s*([^;]+)/
const SLANT = /(?:^|;)\s*font-style:\s*([^;]+)/
const SIZE = /(?:^|;)\s*font-size:\s*([\d.]+)pt/

interface Font {
  bold: boolean
  italic: boolean
  size: number
}

const PLAIN: Font = { bold: false, italic: false, size: 0 }

/** A nested font: what its own style sets, the enclosing font's for the rest. */
function fontOf(attributes: string, outer: Font): Font {
  const style = attributes.match(/style="([^"]*)"/)?.[1] ?? ''
  const weight = style.match(WEIGHT)?.[1]?.trim()
  const slant = style.match(SLANT)?.[1]?.trim()
  const size = style.match(SIZE)?.[1]
  return {
    bold: weight === undefined ? outer.bold : weight === 'bold' || weight === '700',
    italic: slant === undefined ? outer.italic : slant === 'italic',
    size: size === undefined ? outer.size : Number(size),
  }
}

/** Every printed line in document order. */
export function docLines(html: string): DocLine[] {
  const lines: DocLine[] = []
  for (const m of html.matchAll(LINE)) {
    const stack: Font[] = [PLAIN]
    const runs: (Font & { text: string })[] = []
    for (const t of m[1]!.matchAll(TOKEN)) {
      if (t[4] !== undefined) runs.push({ ...stack.at(-1)!, text: decodeEntities(t[4]) })
      else if (t[2]!.toLowerCase() === 'font') {
        if (!t[1]) stack.push(fontOf(t[3]!, stack.at(-1)!))
        else if (stack.length > 1) stack.pop()
      }
    }
    const text = runs
      .map((r) => r.text)
      .join('')
      .replace(/[\s ]+/g, ' ')
      .trim()
    if (!text) continue
    const inked = runs.filter((r) => r.text.trim() !== '')
    lines.push({
      at: m.index!,
      end: m.index! + m[0].length,
      text,
      bold: inked.every((r) => r.bold),
      italic: inked.every((r) => r.italic),
      size: Math.max(...inked.map((r) => r.size)),
    })
  }
  return lines
}

/** The lines joined into one string, with where each line starts in it. */
export interface DocText {
  lines: DocLine[]
  text: string
  starts: number[]
}

export function docText(lines: DocLine[]): DocText {
  const starts: number[] = []
  let at = 0
  for (const line of lines) {
    starts.push(at)
    at += line.text.length + 1
  }
  return { lines, text: lines.map((l) => l.text).join(' '), starts }
}

/** The index of the line holding character `index` of the joined text. */
export function lineAt(doc: DocText, index: number): number {
  let lo = 0
  let hi = doc.starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (doc.starts[mid]! <= index) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Every match of `re` (global) in the joined text, with the line it starts on and the one it ends on. */
export function findAll(
  doc: DocText,
  re: RegExp,
): { match: RegExpExecArray; first: number; last: number }[] {
  if (!re.global) throw new Error('findAll needs a global pattern')
  return [...doc.text.matchAll(re)].map((match) => ({
    match,
    first: lineAt(doc, match.index),
    last: lineAt(doc, match.index + Math.max(0, match[0].length - 1)),
  }))
}

/**
 * The first `<table>` opening within `maxGap` bytes after `at`, as its rows'
 * non-empty cells; null when none opens that close.
 */
export function tableAfter(
  html: string,
  at: number,
  maxGap: number,
): { rows: string[][]; start: number; end: number } | null {
  const start = html.indexOf('<table', at)
  if (start === -1 || start - at > maxGap) return null
  const close = html.indexOf('</table>', start)
  if (close === -1) throw new Error(`table at byte ${start} is not closed`)
  const end = close + '</table>'.length
  const rows = tableRows(html.slice(start, end))
    .map((r) => r.filter((c) => c !== ''))
    .filter((r) => r.length > 0)
  return { rows, start, end }
}

/** One cell of a table row with the grid column it starts at and how many it spans. */
export interface GridCell {
  text: string
  col: number
  span: number
}

/**
 * A table's rows with each cell's grid position, empty cells included, so a
 * header spanning several columns can be matched to the cells beneath it.
 */
export function tableGrid(tableHtml: string): GridCell[][] {
  return [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => {
    let col = 0
    return [...row[1]!.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((c) => {
      const span = Number(c[1]!.match(/colspan="(\d+)"/i)?.[1] ?? 1)
      const cell = { text: cellText(c[2]!), col, span }
      col += span
      return cell
    })
  })
}

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/** A date as a prospectus prints it: "September 30, 2026". */
export const DATE_PATTERN = String.raw`[A-Z][a-z]+ \d{1,2}, \d{4}`

export const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** "September 30, 2026" -> 2026-09-30; throws on anything else. */
export function isoDate(text: string): string {
  const m = text.trim().match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/)
  const month = m ? MONTHS.indexOf(m[1] as (typeof MONTHS)[number]) + 1 : 0
  if (!m || month === 0) throw new Error(`not a date: ${text}`)
  return iso(Number(m[3]), month, Number(m[2]))
}

/**
 * A printed figure: "$ 4,585" -> 4585, "(551)" or "$ (1.42)" -> negative, a
 * dash or blank -> null. Anything else throws: a cell that is not a figure
 * means the table is not the shape the parser was written for.
 */
export function figure(cell: string, what: string): number | null {
  const t = cell.replace(/[$\s]/g, '')
  if (t === '' || t === '—' || t === '-' || t === '–') return null
  const m = t.match(/^(\()?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(\))?$/)
  if (!m || Boolean(m[1]) !== Boolean(m[3])) throw new Error(`${what} is not a figure: ${cell}`)
  const n = Number(m[2]!.replace(/,/g, ''))
  return m[1] ? -n : n
}

/** "Purchase commitments (3)" -> "Purchase commitments": footnote markers off a row label. */
export function rowLabel(cell: string): string {
  return cell.replace(/(?:\s*\(\d+\))+$/, '').trim()
}
