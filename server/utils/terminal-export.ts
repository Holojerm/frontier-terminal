// Bulk exports of the store: every table, as CSV or JSON, streamed in pages
// so a 100k-row changes table never has to fit in Worker memory at once.
//
// The entity views (prices_latest, jobs_open, incidents, rankings_daily) flatten the JSON payload
// into columns, because a CSV with a JSON blob in one cell is not a
// spreadsheet anyone can sort. Provenance columns are always present and
// always last: source_url and fetched_at on every table except source_runs,
// which has no fetched_at by design (a failed run fetched nothing) and
// carries started_at instead.
//
// Pure functions of the Drizzle client, so test/terminal-export.test.ts can
// drive them against the workerd D1 and read the bytes back.

import { asc, count, eq, type SQL } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

import * as tables from '../db/schema'
import type { PipelineDb } from '../pipeline/store'

export const EXPORT_PAGE_SIZE = 200

type Row = Record<string, unknown>

export interface ExportTable {
  name: string
  description: string
  columns: readonly string[]
  /** One page of rows in a stable order, already reduced to `columns`. */
  page(db: PipelineDb, offset: number, limit: number): Promise<Row[]>
  count(db: PipelineDb): Promise<number>
}

const PROVENANCE = ['source_url', 'fetched_at'] as const

const PRICE_FIELDS = [
  'model_slug',
  'tier',
  'context_window',
  'input_per_mtok',
  'cached_input_per_mtok',
  'output_per_mtok',
  'currency',
  'effective_from',
  'effective_until',
  'notes',
] as const

const RANKING_FIELDS = ['date', 'model_permaslug', 'total_tokens'] as const

const JOB_FIELDS = [
  'job_id',
  'title',
  'department',
  'team',
  'location',
  'employment_type',
  'published_at',
  'updated_at',
  'company_name',
] as const

const INCIDENT_FIELDS = [
  'incident_id',
  'title',
  'impact',
  'status',
  'started_at',
  'resolved_at',
  'components',
  'incident_url',
] as const

function parsePayload(text: string): Row {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Row)
      : {}
  } catch {
    return {}
  }
}

/** Keep only `columns`, in order, with null for anything the row lacks. */
function project(row: Row, columns: readonly string[]): Row {
  const out: Row = {}
  for (const column of columns) out[column] = row[column] ?? null
  return out
}

function entityView(
  name: string,
  description: string,
  entityType: 'model' | 'job' | 'incident' | 'ranking',
  fields: readonly string[],
): ExportTable {
  const columns = [
    'entity_key',
    'source_id',
    'provider',
    ...fields,
    'content_hash',
    'snapshot_id',
    'first_seen_at',
    ...PROVENANCE,
  ]
  const ofType = eq(tables.entities.entity_type, entityType)
  return {
    name,
    description,
    columns,
    async page(db, offset, limit) {
      const rows = await db
        .select()
        .from(tables.entities)
        .where(ofType)
        .orderBy(asc(tables.entities.source_id), asc(tables.entities.entity_key))
        .limit(limit)
        .offset(offset)
      return rows.map(({ payload, ...rest }) =>
        project({ ...parsePayload(payload), ...rest }, columns),
      )
    },
    async count(db) {
      const [row] = await db.select({ total: count() }).from(tables.entities).where(ofType)
      return row?.total ?? 0
    },
  }
}

function plainTable(
  name: string,
  description: string,
  table: SQLiteTable,
  columns: readonly string[],
  order: SQL[],
): ExportTable {
  return {
    name,
    description,
    columns,
    async page(db, offset, limit) {
      const rows = await db
        .select()
        .from(table)
        .orderBy(...order)
        .limit(limit)
        .offset(offset)
      return rows.map((row) => project(row as Row, columns))
    },
    async count(db) {
      const [row] = await db.select({ total: count() }).from(table)
      return row?.total ?? 0
    },
  }
}

export const EXPORT_TABLES: Readonly<Record<string, ExportTable>> = {
  snapshots: plainTable(
    'snapshots',
    'One row per fetch of every source: content hash, HTTP status, byte count, and the R2 key of the raw payload.',
    tables.snapshots,
    ['id', 'source_id', 'content_hash', 'raw_key', 'http_status', 'bytes', ...PROVENANCE],
    [asc(tables.snapshots.fetched_at), asc(tables.snapshots.id)],
  ),
  prices_latest: entityView(
    'prices_latest',
    'The current price/catalog row per SKU and source — what each vendor page says right now.',
    'model',
    PRICE_FIELDS,
  ),
  jobs_open: entityView(
    'jobs_open',
    'Every role currently listed on the tracked boards. A role that closes leaves this view and lands in changes.',
    'job',
    JOB_FIELDS,
  ),
  incidents: entityView(
    'incidents',
    'Every status-page incident held: title, vendor impact and status verbatim, start and resolution, components. Append-only — an incident that scrolls out of its feed stays.',
    'incident',
    INCIDENT_FIELDS,
  ),
  rankings_daily: entityView(
    'rankings_daily',
    'One row per UTC day and model from OpenRouter’s usage rankings: total tokens routed. CC BY 4.0 — cite "Source: OpenRouter (openrouter.ai/rankings)".',
    'ranking',
    RANKING_FIELDS,
  ),
  changes: plainTable(
    'changes',
    'Append-only change log: added / removed / modified per entity, with the before and after payloads.',
    tables.changes,
    [
      'id',
      'entity_key',
      'entity_type',
      'provider',
      'change_type',
      'before_hash',
      'after_hash',
      'before_json',
      'after_json',
      'detected_at',
      ...PROVENANCE,
    ],
    [asc(tables.changes.detected_at), asc(tables.changes.id)],
  ),
  alerts: plainTable(
    'alerts',
    'Every alert fired, with the change ids it cites and the rule that produced it.',
    tables.alerts,
    [
      'id',
      'severity',
      'headline',
      'explanation',
      'change_ids',
      'rule',
      'created_at',
      ...PROVENANCE,
    ],
    [asc(tables.alerts.created_at), asc(tables.alerts.id)],
  ),
  source_runs: plainTable(
    'source_runs',
    'One row per (poll tick, source): what was attempted and how it ended. No fetched_at — a failed run fetched nothing.',
    tables.sourceRuns,
    [
      'id',
      'scope',
      'source_id',
      'started_at',
      'status',
      'detail',
      'snapshot_id',
      'added',
      'removed',
      'modified',
      'source_url',
    ],
    [asc(tables.sourceRuns.started_at), asc(tables.sourceRuns.id)],
  ),
}

export const EXPORT_TABLE_NAMES = Object.keys(EXPORT_TABLES)

export function exportTable(name: string): ExportTable | null {
  return Object.prototype.hasOwnProperty.call(EXPORT_TABLES, name) ? EXPORT_TABLES[name]! : null
}

export type ExportFormat = 'csv' | 'json'

/**
 * `<table>.<format>` off a request path. The route files are named
 * `[table].csv.get.ts` and `[table].json.get.ts`, but a router param cannot
 * own half a segment: Nitro registers both as catch-alls over `/export/x`
 * and whichever registered first answers every request. So neither the
 * table nor the format is trusted to the router — both are read here, and
 * either route file serves either format correctly.
 */
export function parseExportPath(path: string): { name: string; format: ExportFormat } | null {
  const file = path.split('?')[0]!.split('/').pop() ?? ''
  const match = file.match(/^([a-z_]+)\.(csv|json)$/)
  return match ? { name: match[1]!, format: match[2] as ExportFormat } : null
}

// ---- CSV -------------------------------------------------------------------

/** RFC 4180: quote when the value carries a comma, a quote, or a line break.
 * A list (an incident's components) is one JSON cell, not a comma-joined string
 * that a spreadsheet would split. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`
}

// ---- streaming -------------------------------------------------------------

async function* pages(db: PipelineDb, table: ExportTable): AsyncGenerator<Row[]> {
  for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
    const rows = await table.page(db, offset, EXPORT_PAGE_SIZE)
    if (rows.length === 0) return
    yield rows
    if (rows.length < EXPORT_PAGE_SIZE) return
  }
}

export async function* csvChunks(db: PipelineDb, table: ExportTable): AsyncGenerator<string> {
  yield csvLine(table.columns)
  for await (const rows of pages(db, table)) {
    yield rows.map((row) => csvLine(table.columns.map((c) => row[c]))).join('')
  }
}

export async function* jsonChunks(db: PipelineDb, table: ExportTable): AsyncGenerator<string> {
  yield '[\n'
  let first = true
  for await (const rows of pages(db, table)) {
    const body = rows.map((row) => JSON.stringify(row)).join(',\n')
    yield `${first ? '' : ',\n'}${body}`
    first = false
  }
  yield '\n]\n'
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
