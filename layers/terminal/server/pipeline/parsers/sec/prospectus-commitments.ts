import { CommitmentRow, type CommitmentLine, type Provenance } from '../../contracts'
import type { RegistrationTarget } from './filing-index'
import {
  DATE_PATTERN,
  figure,
  findAll,
  isoDate,
  rowLabel,
  tableAfter,
  type DocText,
} from './prospectus-doc'

// Contractual commitments a registration document prints — for a frontier
// lab, overwhelmingly compute. Four schedules, each found by the sentence that
// introduces it and read from the table or sentence itself:
//
//   - MD&A's contractual-obligations table ("…summarizes our contractual
//     obligations as of September 30, 2026:"): every obligation by year due;
//   - MD&A's aggregate ("In aggregate, … are approximately $895.4 billion"),
//     which adds short-term and subsequent commitments the table leaves out;
//   - the commitments note's schedule of non-cancelable purchase commitments
//     by year, part of the audited statements;
//   - the note's interim total ("As of September 30, 2026 (unaudited), …
//     approximately $313.8 billion").
//
// A preliminary prospectus may print a schedule's frame with every figure
// blank ("as of :", "approximately $ ,"); that is no row, not a row of
// zeros. A schedule whose sentence is found but whose table or figure is not
// the expected shape throws: the parse never returns part of a schedule.

const DATE = DATE_PATTERN
const BIG = String.raw`(\d[\d,]*(?:\.\d+)?) (billion|million)`

const MDA_TABLE = new RegExp(
  String.raw`The following table summarizes our contractual obligations as of (${DATE})?\s?:`,
  'g',
)
const AGGREGATE_LOOSE = /In aggregate, the contractual obligations in the table below/g
const AGGREGATE = new RegExp(
  String.raw`In aggregate, the contractual obligations in the table below[^$]*? are approximately \$\s?(?:${BIG})?\s?,[^.]*\.`,
  'g',
)
const NOTE_LOOSE =
  /Future minimum payments under the Company[’']s non-cancelable purchase commitments/g
const NOTE_TABLE = new RegExp(
  String.raw`Future minimum payments under the Company[’']s non-cancelable purchase commitments with a remaining term in excess of one year as of (${DATE}) were as follows \(in (millions|thousands)\):`,
  'g',
)
const INTERIM_LOOSE =
  /expected future fixed or minimum guaranteed commitments under these agreements/g
const INTERIM = new RegExp(
  String.raw`As of (${DATE}) \(unaudited\), expected future fixed or minimum guaranteed commitments under these agreements were approximately \$\s?(?:${BIG})?[^.]*\.`,
  'g',
)

const TABLE_GAP = 5000
const scaleOf = (word: string) =>
  ({ billion: 1e9, million: 1e6, millions: 1e6, thousands: 1e3 })[word.toLowerCase()]!

/** A bucketed line must add up to its own total, within one printed unit per bucket. */
function foot(line: CommitmentLine, scale: number): void {
  if (!line.buckets.length) return
  const sum = line.buckets.reduce((s, b) => s + b.val, 0)
  if (Math.abs(sum - line.total) > line.buckets.length * scale) {
    throw new Error(`commitments "${line.label}" do not foot: ${line.total} printed, ${sum} summed`)
  }
}

/** The one value every match agrees on; throws when two differ. */
function one<T>(found: T[], what: string): T | null {
  const distinct = [...new Map(found.map((f) => [JSON.stringify(f), f])).values()]
  if (distinct.length > 1) throw new Error(`${what} is printed twice with different figures`)
  return distinct[0] ?? null
}

type Schedule = Pick<
  CommitmentRow,
  'schedule' | 'as_of' | 'audited' | 'approximate' | 'statement' | 'lines'
>

function mdaTable(html: string, doc: DocText): Schedule | null {
  const hits = findAll(doc, MDA_TABLE)
  if (hits.length > 1) throw new Error('two contractual-obligations tables')
  const hit = hits[0]
  if (!hit) return null
  const table = tableAfter(html, doc.lines[hit.last]!.end, TABLE_GAP)
  if (!table) throw new Error('contractual-obligations sentence is not followed by a table')
  const head = table.rows.findIndex((r) => /^\(in (millions|thousands)\)$/i.test(r[0]!))
  if (head === -1) throw new Error('contractual-obligations table states no units')
  const scale = scaleOf(table.rows[head]![0]!.match(/millions|thousands/i)![0])
  const columns = table.rows[head]!.slice(1)
  if (columns[0] !== 'Total' || columns.length < 2) {
    throw new Error(
      `contractual-obligations columns are not Total then years: ${columns.join(' | ')}`,
    )
  }
  const body = table.rows.slice(head + 1)
  const asOf = hit.match[1]
  if (!asOf) {
    // The frame of a table whose figures the filing has not filled in yet.
    if (body.some((r) => r.length > 1)) {
      throw new Error('contractual-obligations table has figures but no as-of date')
    }
    return null
  }
  const lines = body.map((r): CommitmentLine => {
    if (r.length !== columns.length + 1) {
      throw new Error(
        `contractual obligation "${r[0]}" has ${r.length - 1} values for ${columns.length} columns`,
      )
    }
    const vals = r.slice(1).map((c) => (figure(c, `contractual obligation "${r[0]}"`) ?? 0) * scale)
    return {
      label: rowLabel(r[0]!),
      total: vals[0]!,
      buckets: columns.slice(1).map((label, i) => ({ label, val: vals[i + 1]! })),
    }
  })
  if (!lines.length) throw new Error('contractual-obligations table has no rows')
  for (const line of lines) foot(line, scale)
  const total = lines.find((l) => /^Total\b/.test(l.label))
  if (total) {
    const parts = lines.filter((l) => l !== total)
    const sum = parts.reduce((s, l) => s + l.total, 0)
    if (Math.abs(sum - total.total) > parts.length * scale) {
      throw new Error(
        `contractual obligations do not sum to their total: ${total.total} printed, ${sum} summed`,
      )
    }
  }
  return {
    schedule: 'contractual_obligations',
    as_of: isoDate(asOf),
    audited: false,
    approximate: false,
    statement: null,
    lines,
  }
}

function aggregate(doc: DocText): Schedule | null {
  const loose = findAll(doc, AGGREGATE_LOOSE)
  if (!loose.length) return null
  const hits = findAll(doc, AGGREGATE)
  if (hits.length !== loose.length)
    throw new Error('aggregate-obligations sentence is not the expected shape')
  const found = one(
    hits
      .filter((h) => h.match[1])
      .map((h) => ({ sentence: h.match[0], n: h.match[1]!, unit: h.match[2]! })),
    'aggregate obligations',
  )
  if (!found) return null
  return {
    schedule: 'obligations_aggregate',
    as_of: null,
    audited: false,
    approximate: true,
    statement: found.sentence,
    lines: [
      {
        label: 'Aggregate obligations',
        total: Math.round(Number(found.n.replace(/,/g, '')) * scaleOf(found.unit)),
        buckets: [],
      },
    ],
  }
}

function noteTable(html: string, doc: DocText): Schedule | null {
  const hits = findAll(doc, NOTE_TABLE)
  if (hits.length !== findAll(doc, NOTE_LOOSE).length) {
    throw new Error('purchase-commitments sentence is not the expected shape')
  }
  if (!hits.length) return null
  const schedules = hits.map((hit) => {
    const table = tableAfter(html, doc.lines[hit.last]!.end, TABLE_GAP)
    if (!table) throw new Error('purchase-commitments sentence is not followed by a table')
    const scale = scaleOf(hit.match[2]!)
    const body = table.rows.filter((r) => !(r.length === 2 && /^Amount$/i.test(r[1]!)))
    for (const r of body) {
      if (r.length !== 2)
        throw new Error(`purchase-commitments row is not a label and an amount: ${r.join(' | ')}`)
    }
    const totalRow = body.at(-1)
    if (!totalRow || !/^Total\b/.test(totalRow[0]!)) {
      throw new Error('purchase-commitments table does not end in a total')
    }
    const amount = (r: string[]) => {
      const v = figure(r[1]!, `purchase commitment "${r[0]}"`)
      if (v === null) throw new Error(`purchase commitment "${r[0]}" is blank`)
      return v * scale
    }
    const line: CommitmentLine = {
      label: rowLabel(totalRow[0]!),
      total: amount(totalRow),
      buckets: body.slice(0, -1).map((r) => ({ label: r[0]!, val: amount(r) })),
    }
    if (!line.buckets.length) throw new Error('purchase-commitments table has no years')
    foot(line, scale)
    return { as_of: isoDate(hit.match[1]!), line }
  })
  const found = one(schedules, 'the purchase-commitments schedule')!
  return {
    schedule: 'purchase_commitments',
    as_of: found.as_of,
    audited: !/\(unaudited\)/.test(hits[0]!.match[0]),
    approximate: false,
    statement: null,
    lines: [found.line],
  }
}

function interim(doc: DocText): Schedule | null {
  const loose = findAll(doc, INTERIM_LOOSE)
  if (!loose.length) return null
  const hits = findAll(doc, INTERIM)
  if (hits.length !== loose.length)
    throw new Error('interim purchase-commitments sentence is not the expected shape')
  const found = one(
    hits
      .filter((h) => h.match[2])
      .map((h) => ({
        sentence: h.match[0],
        as_of: isoDate(h.match[1]!),
        n: h.match[2]!,
        unit: h.match[3]!,
      })),
    'the interim purchase-commitments total',
  )
  if (!found) return null
  return {
    schedule: 'purchase_commitments_interim',
    as_of: found.as_of,
    audited: false,
    approximate: true,
    statement: found.sentence,
    lines: [
      {
        label: 'Fixed or minimum guaranteed commitments',
        total: Math.round(Number(found.n.replace(/,/g, '')) * scaleOf(found.unit)),
        buckets: [],
      },
    ],
  }
}

export function parseProspectusCommitments(
  html: string,
  doc: DocText,
  target: RegistrationTarget,
  cik: string,
  entityName: string,
  prov: Provenance,
): CommitmentRow[] {
  return [mdaTable(html, doc), aggregate(doc), noteTable(html, doc), interim(doc)]
    .filter((s) => s !== null)
    .map((s) =>
      CommitmentRow.parse({
        provider: target.provider,
        cik,
        entity_name: entityName,
        accession_no: target.accession_no,
        form: target.form,
        filed: target.filed,
        ...s,
        ...prov,
      }),
    )
}
