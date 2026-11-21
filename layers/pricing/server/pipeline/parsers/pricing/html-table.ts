// Minimal HTML table reader for the archived pricing pages (wayback-*.ts):
// the pages the Internet Archive holds from before the labs published
// markdown. Pure string work, no DOM, document order preserved, the same
// contract as md-table.ts: a missing heading or table throws, so a page that
// changed shape is skipped with a reason rather than read wrongly.

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  middot: '·',
  times: '×',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : +name.slice(1)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Visible text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
export function htmlText(fragment: string): string {
  return decodeEntities(fragment.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/[\s ​]+/g, ' ')
    .trim()
}

/** The document without the parts that are never visible text. */
export function stripInvisible(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, '')
}

/**
 * Undo a markdown renderer that read a pair of dollar signs as inline math.
 * Anthropic's docs printed "$0.25 / $1.25" in 2024 as KaTeX: the text between
 * the two "$" became a math span (its TeX source kept in an <annotation>) and
 * the dollar signs were dropped. Each math span is put back as `$<tex>$`, the
 * markdown it was rendered from, so the cell reads "$0.25 / $1.25" again.
 */
export function unrenderInlineMath(html: string): string {
  const OPEN = '<span class="math math-inline">'
  let out = ''
  let from = 0
  for (;;) {
    const start = html.indexOf(OPEN, from)
    if (start === -1) return out + html.slice(from)
    let depth = 0
    let end = -1
    for (const m of html.slice(start).matchAll(/<span\b[^>]*>|<\/span>/g)) {
      depth += m[0] === '</span>' ? -1 : 1
      if (depth === 0) {
        end = start + m.index + m[0].length
        break
      }
    }
    if (end === -1) return out + html.slice(from)
    const tex = html
      .slice(start, end)
      .match(/<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/)
    out += html.slice(from, start) + (tex ? `$${tex[1]}$` : html.slice(start, end))
    from = end
  }
}

export interface HtmlSection {
  /** The nearest heading before the tables, as visible text. */
  heading: string
  level: number
  /** Every table between this heading and the next, each a list of rows of cell texts. */
  tables: string[][][]
}

const TOKEN = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<table\b[^>]*>([\s\S]*?)<\/table>/gi

function tableCells(inner: string): string[][] {
  const rows: string[][] = []
  for (const tr of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) =>
      htmlText(c[2]!),
    )
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/**
 * Headings and tables in document order: each table belongs to the nearest
 * heading before it. Nested tables are not supported (none of the archived
 * pricing pages nests one).
 */
export function htmlSections(html: string): HtmlSection[] {
  const sections: HtmlSection[] = []
  let current: HtmlSection = { heading: '', level: 0, tables: [] }
  sections.push(current)
  for (const m of stripInvisible(html).matchAll(TOKEN)) {
    if (m[1]) {
      current = { heading: htmlText(m[2]!), level: Number(m[1][1]), tables: [] }
      sections.push(current)
    } else {
      current.tables.push(tableCells(m[3]!))
    }
  }
  return sections
}

/**
 * Every table in the document laid out on a grid: a cell with rowspan or
 * colspan fills each slot it covers, so a price printed once across two model
 * columns, or a band label printed once beside three rows, is read in every
 * row and column it applies to. Header and body rows alike, in order.
 */
export function htmlGridTables(html: string): string[][][] {
  const out: string[][][] = []
  for (const t of stripInvisible(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const grid: string[][] = []
    const rows = [...t[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]!)
    rows.forEach((tr, r) => {
      grid[r] ??= []
      let c = 0
      for (const m of tr.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
        while (grid[r]![c] !== undefined) c++
        const rowspan = Number(m[2]!.match(/rowspan="?(\d+)/i)?.[1] ?? 1)
        const colspan = Number(m[2]!.match(/colspan="?(\d+)/i)?.[1] ?? 1)
        const text = htmlText(m[3]!)
        for (let dr = 0; dr < rowspan; dr++) {
          grid[r + dr] ??= []
          for (let dc = 0; dc < colspan; dc++) grid[r + dr]![c + dc] = text
        }
        c += colspan
      }
    })
    out.push(grid.filter((row) => row.length > 0).map((row) => Array.from(row, (x) => x ?? '')))
  }
  return out
}

/** The tables under the first heading whose text is exactly `heading`. Throws when absent. */
export function htmlTablesUnder(sections: readonly HtmlSection[], heading: string): string[][][] {
  const s = sections.find((x) => x.heading === heading)
  if (!s) throw new Error(`heading not found: ${heading}`)
  if (s.tables.length === 0) throw new Error(`no table under heading: ${heading}`)
  return s.tables
}

/**
 * A printed dollar amount scaled to per-million-tokens without floating-point
 * drift: "$0.0004" per 1K tokens -> 0.4. `perTokens` is the unit the page
 * prints (1_000 or 1_000_000). Throws on anything that is not literally a
 * leading dollar amount — the same rule as md-table.ts › usdAmount.
 */
export function usdPerMillion(cell: string, perTokens: 1_000 | 1_000_000): number {
  const m = cell.trim().match(/^\$(\d+)(?:\.(\d+))?/)
  if (!m) throw new Error(`cell does not print a USD amount: ${cell}`)
  const shift = perTokens === 1_000 ? 3 : 0
  const frac = (m[2] ?? '').padEnd(shift, '0')
  const digits = `${m[1]}${frac.slice(0, shift)}.${frac.slice(shift) || '0'}`
  return Number(digits)
}
