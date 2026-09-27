// The text a reader sees in a fragment of server-rendered HTML: tags dropped,
// entities decoded, whitespace collapsed. No DOM library, the same choice
// google-pricing.ts makes: these pages are regular enough to scan.

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    const key = name.toLowerCase()
    return Object.hasOwn(NAMED, key) ? NAMED[key]! : whole
  })
}

/** Visible text of an HTML fragment: `<br>` is a space, every other tag is dropped. */
export function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-z][^>]*>/gi, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * An ISO date for a value that is exactly one printed date ("Sep 20, 2026",
 * "September 11, 2026"), else null. A value naming two dates ("May 8, 2026
 * and May 15, 2026") is not one date and stays null.
 */
export function printedDate(value: string): string | null {
  const m = value.trim().match(/^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/)
  if (!m) return null
  const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase())
  if (month === -1) return null
  const day = Number(m[2])
  const iso = `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  // Round-trip through Date so "Feb 30" is refused rather than rolled over.
  const d = new Date(`${iso}T00:00:00Z`)
  return d.getUTCMonth() === month && d.getUTCDate() === day ? iso : null
}
