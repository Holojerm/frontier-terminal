import { StatementRow, type Provenance, type StatementLine } from '../../contracts'
import type { RegistrationTarget } from './filing-index'
import { figure } from './prospectus-doc'
import { readStatementTable, type StatementTable } from './prospectus-revenue'

// The whole statement of operations a registration document prints — the
// table prospectus-revenue.ts reads one row of — as one row per period, every
// line verbatim. Lines the parser knows get a canonical key so a reader can
// ask for "operating income" across filers; the rest keep their own label.
//
// It fails loudly rather than return a partial statement:
//   - every line must carry one value per period column, or be a section
//     heading with none;
//   - revenue, total operating expenses, operating income or loss, net income
//     or loss, a per-share line and a weighted-average share line must all be
//     present;
//   - every "Total …" line must equal the lines above it since the last
//     heading, total or operating line, and operating income must equal
//     revenue (or gross profit, where printed) less total operating expenses,
//     each within the statement's rounding. A column that slid one cell left
//     fails here.

const CANONICAL: readonly [RegExp, string][] = [
  [/^(?:Total )?Revenues?$/i, 'revenue'],
  [/^(?:Total )?Cost of (?:revenues?|sales)$/i, 'cost_of_revenue'],
  [/^Gross (?:profit|margin)$/i, 'gross_profit'],
  [/^Research and development$/i, 'research_and_development'],
  [/^Sales and marketing$/i, 'sales_and_marketing'],
  [/^General and administrative$/i, 'general_and_administrative'],
  [/^Total operating expenses$/i, 'total_operating_expenses'],
  [
    /^(?:Operating (?:loss|income|income \(loss\))|(?:Loss|Income|Income \(loss\)) from operations)$/i,
    'operating_income',
  ],
  [/^Net (?:loss|income|income \(loss\))$/i, 'net_income'],
  [/^Net (?:loss|income|income \(loss\)) per share\b.*\bbasic and diluted$/i, 'eps_basic_diluted'],
  [/^Weighted-average shares\b.*\bbasic and diluted$/i, 'weighted_shares_basic_diluted'],
]

/** Lines a statement of operations must print for the parse to be trusted. */
const REQUIRED = ['revenue', 'total_operating_expenses', 'operating_income', 'net_income']

/** Lines a reader may look for that this filer's statement does not print. */
export const OPTIONAL_LINES = [
  'cost_of_revenue',
  'gross_profit',
  'research_and_development',
  'sales_and_marketing',
  'general_and_administrative',
] as const

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

function keyOf(label: string, heading: string | null): string {
  // A bare "Basic" under "Net loss per share:" means nothing on its own.
  const full = /^(?:basic|diluted)$/i.test(label) && heading ? `${heading} ${label}` : label
  return CANONICAL.find(([re]) => re.test(full))?.[1] ?? slug(full)
}

function unitOf(label: string): StatementLine['unit'] {
  // "Weighted-average shares used in computing net loss per share" is a share count.
  if (/^weighted[- ]average\b/i.test(label) || /\bshares outstanding\b/i.test(label)) {
    return 'shares'
  }
  if (/\bper share\b/i.test(label)) return 'USD/share'
  return 'USD'
}

/** Shares per printed unit: the units line says when share amounts are scaled. */
function shareScale(units: string): number | null {
  const m = units.match(/share amounts (?:which are )?in (millions|thousands)/i)
  if (m) return m[1]!.toLowerCase() === 'millions' ? 1e6 : 1e3
  if (/except (?:share|per share)/i.test(units)) return 1
  return null
}

interface Printed {
  key: string
  label: string
  /** Per column, as printed; null for a dash. */
  values: (number | null)[] | null
}

function printedLines(statement: StatementTable): Printed[] {
  const lines: Printed[] = []
  let heading: string | null = null
  for (const row of statement.rows) {
    const label = row[0]!
    const cells = row.slice(1)
    if (cells.length === 0) {
      heading = label.replace(/:$/, '')
      lines.push({ key: keyOf(heading, null), label, values: null })
      continue
    }
    if (cells.length !== statement.columns.length) {
      throw new Error(
        `statement line "${label}" has ${cells.length} values for ${statement.columns.length} columns`,
      )
    }
    lines.push({
      key: keyOf(label, heading),
      label,
      values: cells.map((c) => figure(c, `statement line "${label}"`)),
    })
  }
  return lines
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance

/** Arithmetic the statement must satisfy in its own printed units. */
function checkFooting(lines: Printed[], columns: number): void {
  const at = (key: string) => lines.find((l) => l.key === key)?.values ?? null
  let since: Printed[] = []
  for (const line of lines) {
    if (!line.values) {
      since = []
      continue
    }
    if (/^Total\b/i.test(line.label) && since.length > 1) {
      for (let c = 0; c < columns; c++) {
        const sum = since.reduce((s, l) => s + (l.values![c] ?? 0), 0)
        if (!near(sum, line.values[c] ?? 0, since.length)) {
          throw new Error(
            `"${line.label}" does not foot in column ${c + 1}: ${line.values[c]} printed, ${sum} summed`,
          )
        }
      }
    }
    if (/^Total\b/i.test(line.label) || line.key === 'operating_income') since = []
    else if (line.key !== 'revenue' && line.key !== 'gross_profit') since.push(line)
  }
  const base = at('gross_profit') ?? at('revenue')!
  const opex = at('total_operating_expenses')!
  const operating = at('operating_income')!
  for (let c = 0; c < columns; c++) {
    const expected = (base[c] ?? 0) - (opex[c] ?? 0)
    if (!near(expected, operating[c] ?? 0, 2)) {
      throw new Error(
        `operating line does not equal revenue less operating expenses in column ${c + 1}: ${operating[c]} printed, ${expected} computed`,
      )
    }
  }
}

export function parseProspectusStatement(
  html: string,
  target: RegistrationTarget,
  cik: string,
  prov: Provenance,
): StatementRow[] {
  return statementRows(readStatementTable(html), target, cik, prov)
}

/** One row per period of a statement already read. */
export function statementRows(
  statement: StatementTable,
  target: RegistrationTarget,
  cik: string,
  prov: Provenance,
): StatementRow[] {
  const lines = printedLines(statement)
  const keys = lines.filter((l) => l.values).map((l) => l.key)
  const missing = REQUIRED.filter((k) => !keys.includes(k))
  if (!keys.some((k) => unitOf(lines.find((l) => l.key === k)!.label) === 'USD/share')) {
    missing.push('a per-share line')
  }
  if (!keys.some((k) => unitOf(lines.find((l) => l.key === k)!.label) === 'shares')) {
    missing.push('a weighted-average share line')
  }
  if (missing.length) throw new Error(`statement of operations lacks ${missing.join(', ')}`)
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
  if (dupes.length) throw new Error(`statement prints two lines keyed ${dupes.join(', ')}`)
  checkFooting(lines, statement.columns.length)

  const shares = shareScale(statement.units)
  if (shares === null) {
    throw new Error(`units line does not say how share amounts are stated: ${statement.units}`)
  }
  const scaled = (line: Printed, v: number | null): number | null => {
    if (v === null) return null
    const unit = unitOf(line.label)
    if (unit === 'USD/share') return v
    // Integer arithmetic on the printed digits: 33,242 × 1e6 must not drift.
    return Math.round(v * (unit === 'shares' ? shares : statement.scale))
  }

  const rows = statement.columns.map((column, c) =>
    StatementRow.parse({
      provider: target.provider,
      cik,
      entity_name: statement.entity_name,
      accession_no: target.accession_no,
      form: target.form,
      filed: target.filed,
      start: column.start,
      end: column.end,
      ...(column.unaudited ? { unaudited: true as const } : {}),
      units: statement.units,
      lines: lines
        .filter((l) => l.values)
        .map((l) => ({
          key: l.key,
          label: l.label,
          val: scaled(l, l.values![c] ?? null),
          unit: unitOf(l.label),
        })),
      ...prov,
    }),
  )
  return rows.sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1,
  )
}
