import { ConcentrationRow, type Provenance } from '../../contracts'
import { cellText, type RegistrationTarget } from './filing-index'
import { MONTHS, findAll, iso, tableAfter, tableGrid, type DocText } from './prospectus-doc'
import { periodColumns } from './prospectus-revenue'

// Customer concentration, from the notes' two "10% or more" tables: share of
// revenue per period and share of accounts receivable per balance-sheet date.
// The filing names customers by letter and marks a period under the threshold
// "*" ("Less than 10% of total"); both are kept as printed, the star as null.
// A filing that prints neither table discloses no concentration and yields no
// row; a table that is there but not the expected shape throws.

const TABLES = [
  {
    basis: 'revenue' as const,
    anchor:
      /The table below sets forth concentrations of revenue from customers that accounted for 10% or more of the Company[’']s total revenue:/g,
  },
  {
    basis: 'accounts_receivable' as const,
    anchor:
      /The table below sets forth concentrations of credit risk with respect to accounts receivable from major customers that accounted for 10% or more of the Company[’']s total accounts receivable:/g,
  },
]
const LOOSE = /The table below sets forth concentrations of/g
const TABLE_GAP = 5000
const STAR_NOTE = /\*\s*Less than 10% of total/

/**
 * "As of December 31," spanning 2024 and 2025, then "As of September 30,"
 * over 2026: balance-sheet dates. The years increase across both groups, so
 * each year is matched to the header whose columns it sits under.
 */
function asOfColumns(tableHtml: string): ConcentrationRow['columns'] {
  const grid = tableGrid(tableHtml)
  const header = grid.find((r) => r.some((c) => /^As of [A-Z][a-z]+ \d{1,2},?$/.test(c.text)))
  const years = grid.find((r) => {
    const inked = r.filter((c) => c.text !== '')
    return inked.length > 0 && inked.every((c) => /^\d{4}$/.test(c.text))
  })
  if (!header || !years) throw new Error('receivables table has no as-of header')
  const groups = header.filter((c) => c.text !== '')
  // The first group is the fiscal year-end the audit covers; a later date is interim.
  const first = groups[0]!.text
  return years
    .filter((c) => c.text !== '')
    .map((y) => {
      const g = groups.find((h) => y.col >= h.col && y.col < h.col + h.span)
      const m = g?.text.match(/^As of ([A-Z][a-z]+) (\d{1,2}),?$/)
      const month = m ? MONTHS.indexOf(m[1] as (typeof MONTHS)[number]) + 1 : 0
      if (!g || !m || month === 0)
        throw new Error(`receivables year ${y.text} sits under no as-of header`)
      return {
        start: null,
        end: iso(Number(y.text), month, Number(m[2])),
        unaudited: g.text !== first,
      }
    })
}

function share(cell: string, customer: string): number | null {
  if (cell === '*') return null
  const m = cell.match(/^(\d{1,3})\s?%$/)
  if (!m) throw new Error(`concentration for ${customer} is not a percentage: ${cell}`)
  return Number(m[1])
}

export function parseProspectusConcentration(
  html: string,
  doc: DocText,
  target: RegistrationTarget,
  cik: string,
  entityName: string,
  prov: Provenance,
): ConcentrationRow[] {
  const loose = findAll(doc, LOOSE).length
  const rows: ConcentrationRow[] = []
  let matched = 0
  for (const { basis, anchor } of TABLES) {
    const hits = findAll(doc, anchor)
    matched += hits.length
    if (hits.length > 1) throw new Error(`two ${basis} concentration tables`)
    const hit = hits[0]
    if (!hit) continue
    const table = tableAfter(html, doc.lines[hit.last]!.end, TABLE_GAP)
    if (!table) throw new Error(`${basis} concentration sentence is not followed by a table`)
    const columns =
      basis === 'revenue'
        ? periodColumns(table.rows).columns.map((c) => ({ ...c }))
        : asOfColumns(html.slice(table.start, table.end))
    const body = table.rows.filter(
      (r) =>
        !r.every((c) => /^\d{4}$/.test(c)) &&
        !(r.length === 1 && r[0] === '(unaudited)') &&
        !r.some((c) => /^(?:As of|Year Ended|(?:Three|Six|Nine|Twelve) Months Ended)\b/.test(c)),
    )
    const customers = body.map((r) => {
      if (r.length !== columns.length + 1) {
        throw new Error(
          `${basis} concentration row "${r[0]}" has ${r.length - 1} values for ${columns.length} columns`,
        )
      }
      return { label: r[0]!, pct: r.slice(1).map((c) => share(c, r[0]!)) }
    })
    if (!customers.length) throw new Error(`${basis} concentration table names no customer`)
    if (
      customers.some((c) => c.pct.includes(null)) &&
      !STAR_NOTE.test(cellText(html.slice(table.end, table.end + 3000)))
    ) {
      throw new Error(`${basis} concentration table uses * without its footnote`)
    }
    rows.push(
      ConcentrationRow.parse({
        provider: target.provider,
        cik,
        entity_name: entityName,
        accession_no: target.accession_no,
        form: target.form,
        filed: target.filed,
        basis,
        columns,
        customers,
        ...prov,
      }),
    )
  }
  if (matched !== loose)
    throw new Error('a concentration table’s sentence is not the expected shape')
  return rows
}
