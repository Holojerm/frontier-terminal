// Whether a quoted passage is still on the page it was read from. Used by
// the verify scripts for the hand-read tables (scripts/suppliers-verify.ts,
// scripts/power-sites-verify.ts).

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  reg: '®',
  trade: '™',
  times: '×',
  hellip: '…',
}

/** The page as a reader sees it: no scripts, styles or tags, entities decoded. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
}

/**
 * What two passages are compared on. Whitespace goes, because a tag boundary
 * or a line wrap moves it. Curly quotes and dashes fold to plain ones, because
 * a page and a copy of it disagree on those and on nothing a reader would
 * call a different sentence.
 */
export function comparable(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑–—]/g, '-')
    .replace(/[\s ​]+/g, '')
}
