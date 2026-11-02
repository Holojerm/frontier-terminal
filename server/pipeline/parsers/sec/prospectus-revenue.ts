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

// prospectus-revenue-<provider>-<form>-<filed>-<accession> — the primary
// document of a lab's own registration filing, located by its filing index
// (filing-index.ts). A registration statement need not tag its financials in
// XBRL — Anthropic's S-1 of 2026-10-26 tags only the filing-fee exhibit — so
// until the issuer's first 10-Q, its audited revenue exists only as the
// statement of operations printed in the document. This parser reads that
// one statement and nothing else:
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
const MONTHS = [
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
]
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
  const month = MONTHS.indexOf(m[2]!) + 1
  if (month === 0) return null
  return { months: m[1] ? SPANS[m[1]]! : 12, month, day: Number(m[3]) }
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

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

/** "$4,585" / "386" -> 4585 / 386; a dash or blank -> null. Parentheses (a negative) throw. */
function amount(cell: string): number | null {
  const t = cell.replace(/[$\s]/g, '')
  if (t === '' || t === '—' || t === '-' || t === '–') return null
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(t))
    throw new Error(`revenue cell is not an amount: ${cell}`)
  return Number(t.replace(/,/g, ''))
}

interface Statement {
  entity_name: string
  tag: string
  values: { start: string; end: string; val: number; unaudited: boolean }[]
}

function readStatement(
  html: string,
  titleAt: number,
  at: number,
  nextTitleAt: number,
): Statement | null {
  // A title's units line and table come before the next title: an index
  // entry is followed by another entry, never by a units line of its own.
  const window = html.slice(at, Math.min(at + LOOKAHEAD, nextTitleAt))
  const units = cellText(window).match(/\(In (millions|thousands)\b/i)
  const tableAt = window.search(/<table\b/i)
  if (!units || tableAt === -1) return null
  const scale = units[1]!.toLowerCase() === 'millions' ? 1e6 : 1e3

  const tableStart = at + tableAt
  const tableEnd = html.indexOf('</table>', tableStart)
  if (tableEnd === -1) throw new Error('statement table is not closed')
  const rows = tableRows(html.slice(tableStart, tableEnd)).map((r) => r.filter((c) => c !== ''))

  const groups = rows.flatMap((r) => r.map(periodGroup)).filter((g): g is Group => g !== null)
  const years = rows.find((r) => r.length > 0 && r.every((c) => /^\d{4}$/.test(c)))?.map(Number)
  if (!groups.length || !years) throw new Error('statement has no period header')
  // Columns run oldest to newest within a group; a year that does not
  // increase opens the next group.
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
  const columns = split.flatMap((ys, i) => ys.map((y) => ({ group: groups[i]!, year: y })))

  const revenue = rows.find((r) => REVENUE_LABEL.test(r[0] ?? ''))
  if (!revenue) throw new Error('statement has no revenue row')
  const cells = revenue.slice(1)
  if (cells.length !== columns.length) {
    throw new Error(`revenue row has ${cells.length} values for ${columns.length} columns`)
  }

  // The registrant's name is the text node just above the title (`titleAt`
  // sits one past the title element's opening `<`, so that node's closing `<` is in range).
  const above = [...html.slice(Math.max(0, titleAt - 3000), titleAt).matchAll(/>([^<]+)</g)]
    .map((m) => cellText(m[1]!))
    .filter(Boolean)
  const entity_name = above.at(-1) ?? ''
  if (!entity_name) throw new Error('statement names no registrant')

  const values: Statement['values'] = []
  cells.forEach((cell, i) => {
    const v = amount(cell)
    if (v === null) return
    const { group, year } = columns[i]!
    values.push({
      ...periodOf(group, year),
      val: Math.round(v * scale),
      unaudited: group.months < 12,
    })
  })
  return { entity_name, tag: revenue[0]!, values }
}

export function parseProspectusRevenue(
  html: string,
  target: RegistrationTarget,
  cik: string,
  prov: Provenance,
): RevenueRow[] {
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
    .filter((s): s is Statement => s !== null)
  if (!statements.length)
    throw new Error('no Consolidated Statements of Operations with a units line')
  const [first, ...rest] = statements
  const shape = (s: Statement) => JSON.stringify([s.tag, s.values])
  for (const s of rest) {
    if (shape(s) !== shape(first!))
      throw new Error('two statements of operations disagree on revenue')
  }
  if (!first!.values.length) throw new Error('revenue row carries no amounts')

  const rows: RevenueRow[] = first!.values.map((v) => ({
    cik,
    entity_name: first!.entity_name,
    taxonomy: 'prospectus' as const,
    tag: first!.tag,
    unit: 'USD' as const,
    start: v.start,
    end: v.end,
    val: v.val,
    accession_no: target.accession_no,
    fy: null,
    fp: null,
    form: target.form,
    filed: target.filed,
    frame: null,
    whitelist_cik: null,
    ...(v.unaudited ? { unaudited: true as const } : {}),
    ...prov,
  }))
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
