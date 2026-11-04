import { SharesRow, type Provenance } from '../../contracts'
import type { RegistrationTarget } from './filing-index'
import { DATE_PATTERN, docText, findAll, isoDate, tableAfter, type DocText } from './prospectus-doc'

// Share counts from the prospectus summary's "The Offering" table — shares
// offered by the company and by selling stockholders, the underwriters'
// option, and each class outstanding after the offering — and the sentence
// under it that states the pre-offering basis ("is based on N shares of our
// Class A common stock, … outstanding as of September 30, 2026").
//
// A preliminary prospectus prints the frame with the counts blank ("shares",
// "shares (or shares if the underwriters exercise …)") until the price range
// is set; each blank is null. A row whose value is not a share count in one
// of those shapes throws, and so does a summary with no outstanding-after row.

const TABLE_GAP = 3000
const SHARE_ROW = /\bcommon stock\b|\bshares\b/i
const COUNT = String.raw`(\d[\d,]*|one|no)`
const VALUE = new RegExp(
  String.raw`^(?:${COUNT} )?shares?(?: \(or (?:${COUNT} )?shares? if the underwriters exercise their option to purchase additional shares[^)]*\))?$`,
  'i',
)
const BASIS = new RegExp(
  String.raw`outstanding after this offering is based on (.+?) outstanding as of (${DATE_PATTERN})`,
  'g',
)

function count(word: string | undefined): number | null {
  if (word === undefined) return null
  const w = word.toLowerCase()
  if (w === 'one') return 1
  if (w === 'no') return 0
  return Number(w.replace(/,/g, ''))
}

export function parseProspectusShares(
  html: string,
  doc: DocText,
  target: RegistrationTarget,
  cik: string,
  entityName: string,
  prov: Provenance,
): SharesRow | null {
  // The section title is its own line in the display face, not a TOC entry.
  const title = doc.lines.findIndex((l) => l.text === 'The Offering' && l.bold && l.size >= 14)
  if (title === -1) return null
  const table = tableAfter(html, doc.lines[title]!.end, TABLE_GAP)
  if (!table) throw new Error('"The Offering" is not followed by a table')

  const lines: SharesRow['lines'] = []
  for (const row of table.rows) {
    if (row.length !== 2 || !SHARE_ROW.test(row[0]!)) continue
    const m = row[1]!.match(VALUE)
    if (!m) {
      // A share row whose value is prose (use of proceeds, voting rights) is not a count.
      if (/\b(?:offered|outstanding after this offering|option to purchase)\b/i.test(row[0]!)) {
        throw new Error(`"${row[0]}" is not a share count: ${row[1]}`)
      }
      continue
    }
    lines.push({ label: row[0]!, shares: count(m[1]), with_option: count(m[2]) })
  }
  if (!lines.some((l) => /outstanding after this offering/i.test(l.label))) {
    throw new Error('"The Offering" states no shares outstanding after the offering')
  }

  // The basis sentence follows the table: "…based on [N] shares of our Class A
  // common stock, [N] shares of our Class N common stock, one share of our
  // Class T common stock, … outstanding as of <date>".
  const next = doc.lines.findIndex((l) => l.at >= table.end)
  const basis = findAll(docText(next === -1 ? [] : doc.lines.slice(next, next + 60)), BASIS)[0]
  if (!basis) throw new Error('"The Offering" states no pre-offering basis')
  const before = basis.match[1]!.split(/,\s*(?:and\s+)?|\s+and\s+/)
    .filter(Boolean)
    .map((part) => {
      const m = part.match(new RegExp(String.raw`^(?:${COUNT} )?shares? of our (.+? stock)$`, 'i'))
      if (!m) throw new Error(`pre-offering basis part is not a share count: ${part}`)
      return { label: m[2]!.replace(/^./, (c) => c.toUpperCase()), shares: count(m[1]) }
    })

  return SharesRow.parse({
    provider: target.provider,
    cik,
    entity_name: entityName,
    accession_no: target.accession_no,
    form: target.form,
    filed: target.filed,
    lines,
    before_as_of: isoDate(basis.match[2]!),
    before,
    ...prov,
  })
}
