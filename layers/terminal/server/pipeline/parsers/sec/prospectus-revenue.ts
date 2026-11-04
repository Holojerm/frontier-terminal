import {
  ProspectusRevenueOutput,
  registerParser,
  type ParserId,
  type Provenance,
  type RevenueRow,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import {
  REGISTRATION_FIXTURE,
  archivesCik,
  cellText,
  registrationTarget,
  tableRows,
  type RegistrationTarget,
} from './filing-index'
import { MONTHS, figure, iso } from './prospectus-doc'

// prospectus-revenue-<provider>-<form>-<filed>-<accession> — the primary
// document of a lab's own registration filing, located by its filing index
// (filing-index.ts). A registration statement need not tag its financials in
// XBRL — Anthropic's S-1 of 2026-10-26 tags only the filing-fee exhibit — so
// until the issuer's first 10-Q, its audited revenue exists only as the
// statement of operations printed in the document. This parser reads that
// one statement's revenue row; prospectus-statement.ts reads the rest of the
// same table through readStatementTable():
//
//   - the statement is a heading whose whole text is "Consolidated
//     Statements of Operations", followed within a few KB by a units line
//     ("(In millions" / "(In thousands") and a table — a table-of-contents
//     entry has no units line and is skipped;
//   - periods come from the table's own column headers ("Year Ended
//     December 31," over 2023 2024 2025), never from the filing date;
//   - the revenue row is the first whose label is "Revenue", "Revenues" or
//     "Total revenue(s)", stored under that label verbatim;
//   - every statement occurrence that qualifies must agree, or the parse
//     throws: two different figures for one period in one document is a
//     parse error, not a choice.
//
// Interim columns are flagged `unaudited` — a registration statement's
// interim financials always are. The statement prints no CIK; it is the one
// the derived URL was composed with.

const TITLE = /<[^>]+>\s*Consolidated Statements of Operations\s*</gi
const LOOKAHEAD = 4000
const SPANS: Readonly<Record<string, number>> = { Three: 3, Six: 6, Nine: 9, Twelve: 12 }
const REVENUE_LABEL = /^(?:Total )?Revenues?$/i

interface Group {
  months: number
  month: number
  day: number
}

/** "Year Ended December 31," / "Six Months Ended June 30," -> span and period-end day; null otherwise. */
function periodGroup(text: string): Group | null {
  const m = text.match(
    /^(?:(Three|Six|Nine|Twelve) Months|Years?) Ended ([A-Z][a-z]+) (\d{1,2}),?$/,
  )
  if (!m) return null
  const month = MONTHS.indexOf(m[2]! as (typeof MONTHS)[number]) + 1
  if (month === 0) return null
  return { months: m[1] ? SPANS[m[1]]! : 12, month, day: Number(m[3]) }
}

/** The period a column covers: it must end on a month-end, and starts on the 1st `months` back. */
function periodOf(group: Group, year: number): { start: string; end: string } {
  const lastDay = new Date(Date.UTC(year, group.month, 0)).getUTCDate()
  if (group.day !== lastDay) {
    throw new Error(`period ending ${iso(year, group.month, group.day)} is not a month-end`)
  }
  const startIndex = year * 12 + (group.month - 1) - (group.months - 1)
  return {
    start: iso(Math.floor(startIndex / 12), (startIndex % 12) + 1, 1),
    end: iso(year, group.month, group.day),
  }
}

/** One column of a table headed by period groups over years, oldest to newest within a group. */
export interface PeriodColumn {
  start: string
  end: string
  /** An interim column: a registration statement's interim financials are unaudited. */
  unaudited: boolean
}

/**
 * The columns a table's period header names: "Year Ended December 31," over
 * 2023 2024 2025 and "Nine Months Ended September 30," over 2025 2026 is five
 * columns. Throws when the groups and the runs of years do not line up.
 */
export function periodColumns(rows: readonly string[][]): {
  columns: PeriodColumn[]
  /** Index of the row that holds the years: the body starts after it. */
  yearsRow: number
} {
  const groups = rows.flatMap((r) => r.map(periodGroup)).filter((g): g is Group => g !== null)
  const yearsRow = rows.findIndex((r) => r.length > 0 && r.every((c) => /^\d{4}$/.test(c)))
  if (!groups.length || yearsRow === -1) throw new Error('table has no period header')
  const years = rows[yearsRow]!.map(Number)
  // A year that does not increase opens the next group.
  const split: number[][] = [[]]
  for (const y of years) {
    const current = split.at(-1)!
    if (current.length && y <= current.at(-1)!) split.push([y])
    else current.push(y)
  }
  if (split.length !== groups.length) {
    throw new Error(
      `${groups.length} period headers over ${split.length} runs of years (${years.join(' ')})`,
    )
  }
  const columns = split.flatMap((ys, i) =>
    ys.map((y) => ({ ...periodOf(groups[i]!, y), unaudited: groups[i]!.months < 12 })),
  )
  return { columns, yearsRow }
}

/** "$4,585" / "386" -> 4585 / 386; a dash or blank -> null. Parentheses (a negative) throw. */
function amount(cell: string): number | null {
  const v = figure(cell, 'revenue cell')
  // A negative figure is printed in parentheses; revenue never is.
  if (v !== null && v < 0) throw new Error(`revenue cell is not an amount: ${cell}`)
  return v
}

/** The audited statement as printed: its periods, its units line and every body row. */
export interface StatementTable {
  entity_name: string
  /** The units line verbatim: "(In millions, except share amounts which are in thousands, and per share data)". */
  units: string
  /** Dollars per printed unit for money rows. */
  scale: number
  columns: PeriodColumn[]
  /** Every row below the period header, as its non-empty cells: a label alone is a section heading. */
  rows: string[][]
}

function readStatement(
  html: string,
  titleAt: number,
  at: number,
  nextTitleAt: number,
): StatementTable | null {
  // A title's units line and table come before the next title: an index
  // entry is followed by another entry, never by a units line of its own.
  const window = html.slice(at, Math.min(at + LOOKAHEAD, nextTitleAt))
  const tableAt = window.search(/<table\b/i)
  const units = cellText(tableAt === -1 ? window : window.slice(0, tableAt)).match(
    /\(In (millions|thousands)\b[^)]*\)/i,
  )
  if (!units || tableAt === -1) return null
  const scale = units[1]!.toLowerCase() === 'millions' ? 1e6 : 1e3

  const tableStart = at + tableAt
  const tableEnd = html.indexOf('</table>', tableStart)
  if (tableEnd === -1) throw new Error('statement table is not closed')
  const rows = tableRows(html.slice(tableStart, tableEnd))
    .map((r) => r.filter((c) => c !== ''))
    .filter((r) => r.length > 0)
  const { columns, yearsRow } = periodColumns(rows)

  // The registrant's name is the text node just above the title (`titleAt`
  // sits one past the title element's opening `<`, so that node's closing `<` is in range).
  const above = [...html.slice(Math.max(0, titleAt - 3000), titleAt).matchAll(/>([^<]+)</g)]
    .map((m) => cellText(m[1]!))
    .filter(Boolean)
  const entity_name = above.at(-1) ?? ''
  if (!entity_name) throw new Error('statement names no registrant')

  return {
    entity_name,
    units: units[0]!,
    scale,
    columns,
    rows: rows.slice(yearsRow + 1).filter((r) => !(r.length === 1 && r[0] === '(unaudited)')),
  }
}

/**
 * The one audited Consolidated Statements of Operations in a registration
 * document. Every occurrence that qualifies must agree, or this throws.
 */
export function readStatementTable(html: string): StatementTable {
  const titles = [...html.matchAll(TITLE)]
  const statements = titles
    .map((m, i) =>
      readStatement(
        html,
        m.index! + 1,
        m.index! + m[0].length,
        titles[i + 1]?.index ?? html.length,
      ),
    )
    .filter((s): s is StatementTable => s !== null)
  if (!statements.length)
    throw new Error('no Consolidated Statements of Operations with a units line')
  const [first, ...rest] = statements
  for (const s of rest) {
    if (JSON.stringify(s) !== JSON.stringify(first!))
      throw new Error('two statements of operations disagree')
  }
  return first!
}

export function parseProspectusRevenue(
  html: string,
  target: RegistrationTarget,
  cik: string,
  prov: Provenance,
): RevenueRow[] {
  return revenueFromStatement(readStatementTable(html), target, cik, prov)
}

/** The revenue row of a statement already read. */
export function revenueFromStatement(
  statement: StatementTable,
  target: RegistrationTarget,
  cik: string,
  prov: Provenance,
): RevenueRow[] {
  const revenue = statement.rows.find((r) => REVENUE_LABEL.test(r[0] ?? ''))
  if (!revenue) throw new Error('statement has no revenue row')
  const cells = revenue.slice(1)
  if (cells.length !== statement.columns.length) {
    throw new Error(
      `revenue row has ${cells.length} values for ${statement.columns.length} columns`,
    )
  }
  const rows: RevenueRow[] = []
  cells.forEach((cell, i) => {
    const v = amount(cell)
    if (v === null) return
    const { start, end, unaudited } = statement.columns[i]!
    rows.push({
      cik,
      entity_name: statement.entity_name,
      taxonomy: 'prospectus' as const,
      tag: revenue[0]!,
      unit: 'USD' as const,
      start,
      end,
      val: Math.round(v * statement.scale),
      accession_no: target.accession_no,
      fy: null,
      fp: null,
      form: target.form,
      filed: target.filed,
      frame: null,
      whitelist_cik: null,
      ...(unaudited ? { unaudited: true as const } : {}),
      ...prov,
    })
  })
  if (!rows.length) throw new Error('revenue row carries no amounts')
  rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1))
  return ProspectusRevenueOutput.parse({ rows }).rows
}

registerParser({
  name: REGISTRATION_FIXTURE.prospectusSourceId as ParserId,
  lane: 'sec',
  fixturePath: REGISTRATION_FIXTURE.prospectusPath,
  sideFixturePaths: [],
  schema: ProspectusRevenueOutput,
  parse: (text) => {
    const prov = fixtureProvenance(REGISTRATION_FIXTURE.prospectusSourceId)
    return ProspectusRevenueOutput.parse({
      rows: parseProspectusRevenue(
        text,
        registrationTarget(REGISTRATION_FIXTURE.key),
        archivesCik(prov.source_url),
        prov,
      ),
    })
  },
})
