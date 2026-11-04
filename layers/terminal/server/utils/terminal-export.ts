// Bulk exports of the store: every table, as CSV or JSON, streamed in pages
// so a 100k-row changes table never has to fit in Worker memory at once.
//
// The entity views (prices_latest, jobs_open, incidents, rankings_daily, revenue_facts) flatten the JSON payload
// into columns, because a CSV with a JSON blob in one cell is not a
// spreadsheet anyone can sort. Provenance columns are always present and
// always last: source_url and fetched_at on every table except source_runs,
// which has no fetched_at by design (a failed run fetched nothing) and
// carries started_at instead.
//
// The CSV defuses cells a spreadsheet would execute (see defuseFormula); the
// JSON is verbatim, because nothing executes a JSON string.
//
// `?as_of=` (ExportTable.at) serves a table as the store held it at that instant:
// an append-only table by the column that says when each row was written,
// read as a range on the index its keyset already pages; an entity view
// rebuilt from the change log (terminal-asof.ts); and a table rewritten in
// place with no log refused with a 400, since its past is gone.
//
// Pure functions of the Drizzle client, so layers/terminal/test/terminal-export.test.ts can
// drive them against the workerd D1 and read the bytes back.

import { and, asc, count, eq, lte, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import {
  AS_OF_PARAM,
  PointInTimeError,
  alertsKnownAt,
  judgeCutoffAt,
  rewindEntities,
} from './terminal-asof'
import { byString } from './terminal-json'

export const EXPORT_PAGE_SIZE = 200

type Row = Record<string, unknown>

export interface ExportTable {
  name: string
  description: string
  columns: readonly string[]
  /**
   * One page of rows in a stable order, already reduced to `columns`: the
   * first page for `after` null, else the rows that follow `after` (the last
   * row of the previous page). Keyset, not OFFSET — an offset page re-reads
   * every row before it, so streaming a table was quadratic in its size.
   */
  page(db: PipelineDb, after: Row | null, limit: number, where?: SQL): Promise<Row[]>
  count(db: PipelineDb): Promise<number>
  /** Query parameters this table can be narrowed by (`?recipe_id=`), each an equality on a column. */
  filters?: Readonly<Record<string, SQLiteColumn>>
  /** The table as the store held it at `at`; throws PointInTimeError when its past is not kept. */
  at(db: PipelineDb, at: string): Promise<ExportTable>
  /** Why `at` refuses, or null when it answers. */
  asOfRefusal: string | null
}

/**
 * The equality filters a request asks for, as one SQL condition. A parameter
 * the table does not declare is an error, never silently ignored: an export
 * that ignores `?recipe_id=` hands back the whole table under a name that
 * says otherwise.
 */
export function exportFilter(
  table: ExportTable,
  query: Record<string, unknown>,
): { where: SQL | undefined } | { error: string } {
  const conditions: SQL[] = []
  for (const [name, raw] of Object.entries(query)) {
    if (name === AS_OF_PARAM) continue // ExportTable.at, not a column filter
    const column = table.filters?.[name]
    if (!column) {
      const allowed = Object.keys(table.filters ?? {})
      return {
        error: `${table.name} cannot be filtered by ${name}${allowed.length ? `; it accepts ${allowed.join(', ')}` : ''}`,
      }
    }
    if (typeof raw !== 'string' || !/^[\w.@-]{1,100}$/.test(raw)) {
      return { error: `${name} must be one id of letters, digits, '.', '@' or '-'` }
    }
    conditions.push(eq(column, raw))
  }
  return { where: conditions.length ? and(...conditions) : undefined }
}

/** How an append-only table answers `as_of`: the rows written by `at`. */
type WrittenBy = (db: PipelineDb, at: string) => Promise<SQL | undefined>

/** A unique sort key: the columns a keyset page orders by and resumes after. */
type Key = readonly [SQLiteColumn, ...SQLiteColumn[]]

/** Rows strictly after `after` in the order of `key`, as one row-value compare
 * so SQLite can seek the composite index instead of filtering. */
function afterKey(key: Key, after: Row | null): SQL | undefined {
  if (after === null) return undefined
  const columns = sql.join([...key], sql`, `)
  const values = sql.join(
    key.map((c) => sql`${after[c.name]}`),
    sql`, `,
  )
  return sql`(${columns}) > (${values})`
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

const REVENUE_FIELDS = [
  'cik',
  'entity_name',
  'taxonomy',
  'tag',
  'unit',
  'start',
  'end',
  'val',
  'accession_no',
  'fy',
  'fp',
  'form',
  'filed',
  'frame',
  'whitelist_cik',
] as const

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

const DISCLOSURE_FIELDS = [
  'kind',
  'entry_id',
  'title',
  'summary',
  'model',
  'observed_during',
  'listed_on',
  'entry_url',
] as const

const DISCLOSURE_TIMELINE_FIELDS = [
  'entry_id',
  'title',
  'lines',
  'discovered_on',
  'disclosed_on',
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
  entityType:
    | 'model'
    | 'job'
    | 'incident'
    | 'ranking'
    | 'revenue'
    | 'filer'
    | 'disclosure'
    | 'disclosure_timeline',
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
  const key = [tables.entities.source_id, tables.entities.entity_key] as const
  return {
    name,
    description,
    columns,
    async at(db, at) {
      // The current set is the view; as of T it is rebuilt in memory (one
      // type's rows and change log) and paged by the same keyset.
      const rewound = await rewindEntities(db, entityType, at)
      const unverified = new Set(rewound.unverified)
      const columnsAt = [...columns.slice(0, -2), 'as_of_verified', ...PROVENANCE]
      const rows = rewound.rows.map(({ payload, ...rest }) =>
        project(
          {
            ...parsePayload(payload),
            ...rest,
            as_of_verified: !unverified.has(rest.entity_key),
          },
          columnsAt,
        ),
      )
      const keyOf = (r: Row) => [String(r.source_id), String(r.entity_key)] as const
      return {
        name,
        description,
        columns: columnsAt,
        async page(_db, after, limit) {
          if (after === null) return rows.slice(0, limit)
          const [s, k] = keyOf(after)
          const from = rows.findIndex((r) => {
            const [rs, rk] = keyOf(r)
            return byString(rs, s) > 0 || (rs === s && byString(rk, k) > 0)
          })
          return from === -1 ? [] : rows.slice(from, from + limit)
        },
        count: async () => rows.length,
        at: () => Promise.reject(new PointInTimeError('already a point-in-time view')),
        asOfRefusal: null,
      }
    },
    asOfRefusal: null,
    async page(db, after, limit) {
      const rows = await db
        .select()
        .from(tables.entities)
        .where(and(ofType, afterKey(key, after)))
        .orderBy(...key.map((c) => asc(c)))
        .limit(limit)
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
  key: Key,
  writtenBy: WrittenBy | string,
  total?: SQL<number>,
  filters?: Readonly<Record<string, SQLiteColumn>>,
): ExportTable {
  const pageWhere =
    (filter: SQL | undefined) =>
    async (db: PipelineDb, after: Row | null, limit: number, where?: SQL) => {
      const rows = await db
        .select()
        .from(table)
        .where(and(filter, afterKey(key, after), where))
        .orderBy(...key.map((c) => asc(c)))
        .limit(limit)
      return rows.map((row) => project(row as Row, columns))
    }
  return {
    name,
    description,
    columns,
    filters,
    page: pageWhere(undefined),
    async at(db, at) {
      if (typeof writtenBy === 'string') throw new PointInTimeError(writtenBy)
      const filter = await writtenBy(db, at)
      return {
        name,
        description,
        columns,
        filters,
        page: pageWhere(filter),
        // A count up to T would read every row up to T; nothing asks for it.
        count: () => Promise.reject(new Error('not counted as of T')),
        at: () => Promise.reject(new PointInTimeError('already a point-in-time view')),
        asOfRefusal: null,
      }
    },
    asOfRefusal: typeof writtenBy === 'string' ? writtenBy : null,
    async count(db) {
      if (total) {
        const [row] = await db.select({ total }).from(tables.sourceStats)
        return Number(row?.total ?? 0)
      }
      const [row] = await db.select({ total: count() }).from(table)
      return row?.total ?? 0
    },
  }
}

// The two tables that gain a row per source per tick are counted from
// source_stats; a count(*) over either reads every row ever written.
const loggedTotal = (column: SQLiteColumn) => sql<number>`coalesce(sum(${column}), 0)`

/** Rows whose own timestamp (the leading keyset column, so an index range) is at or before T. */
const byColumn =
  (column: SQLiteColumn): WrittenBy =>
  async (_db, at) =>
    lte(column, at)

export const EXPORT_TABLES: Readonly<Record<string, ExportTable>> = {
  snapshots: plainTable(
    'snapshots',
    'One row per fetch of every source: content hash, HTTP status, byte count, and the R2 key of the raw payload.',
    tables.snapshots,
    ['id', 'source_id', 'content_hash', 'raw_key', 'http_status', 'bytes', ...PROVENANCE],
    [tables.snapshots.fetched_at, tables.snapshots.id],
    byColumn(tables.snapshots.fetched_at),
    loggedTotal(tables.sourceStats.snapshot_count),
  ),
  prices_latest: entityView(
    'prices_latest',
    'The current price and catalog row per SKU and source, as each vendor page states it at the latest poll.',
    'model',
    PRICE_FIELDS,
  ),
  jobs_open: entityView(
    'jobs_open',
    'Every role currently listed on the tracked boards. A closed role leaves this table and is recorded in changes.',
    'job',
    JOB_FIELDS,
  ),
  incidents: entityView(
    'incidents',
    'Every stored status-page incident: title, vendor impact and status verbatim, start and resolution, and components. Append-only: an incident that drops out of its feed is kept.',
    'incident',
    INCIDENT_FIELDS,
  ),
  disclosures: entityView(
    'disclosures',
    'Every entry on a lab’s own misalignment-disclosure index (only OpenAI publishes one): report or notice, title, summary, model, and context verbatim, and the date the index prints beside it. A count measures disclosure, not behavior.',
    'disclosure',
    DISCLOSURE_FIELDS,
  ),
  disclosure_timelines: entityView(
    'disclosure_timelines',
    'The dates printed on each report’s own page: every “Label: value” line verbatim, the discovery date, and a printed disclosure date where the page has one.',
    'disclosure_timeline',
    DISCLOSURE_TIMELINE_FIELDS,
  ),
  rankings_daily: entityView(
    'rankings_daily',
    'One row per UTC day and model from OpenRouter’s usage rankings: total tokens routed. CC BY 4.0; cite “Source: OpenRouter (openrouter.ai/rankings)”.',
    'ranking',
    RANKING_FIELDS,
  ),
  filers: entityView(
    'filers',
    'One row per lab whose CIK was resolved at poll time from its own registration filing (sources.yaml pending_filers): the CIK, EDGAR’s name for the filer, and the filing it was read from.',
    'filer',
    ['provider', 'cik', 'name', 'resolved_form', 'resolved_accession', 'resolved_file_date'],
  ),
  revenue_facts: entityView(
    'revenue_facts',
    'One row per XBRL revenue fact from EDGAR company facts: filer, tag, period, value in USD, and the filing that reported it. Append-only: a restatement is a new row under its own accession.',
    'revenue',
    REVENUE_FIELDS,
  ),
  changes: plainTable(
    'changes',
    'Append-only change log: each entity added, removed, or modified, with the before and after payloads.',
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
    [tables.changes.detected_at, tables.changes.id],
    byColumn(tables.changes.detected_at),
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
    [tables.alerts.created_at, tables.alerts.id],
    async (db, at) => alertsKnownAt(at, await judgeCutoffAt(db, at)),
  ),
  claim_readings: plainTable(
    'claim_readings',
    'One row per thesis claim and data date: the measured value its kill condition is checked against, with the detail behind it (docs/theses/).',
    tables.claimReadings,
    ['thesis_id', 'claim_id', 'date', 'value', 'detail', 'computed_at', ...PROVENANCE],
    [tables.claimReadings.claim_id, tables.claimReadings.date],
    'a claim reading is rewritten in place while its data is revised, and the value it replaced is not kept.',
  ),
  claim_verdicts: plainTable(
    'claim_verdicts',
    'Append-only: the judge’s verdict on each candidate event for a judged thesis claim, with its grounded rationale and the facts the Worker computed (a cut’s size, an outage’s hours).',
    tables.claimVerdicts,
    [
      'id',
      'thesis_id',
      'claim_id',
      'subject',
      'change_id',
      'provider',
      'verdict',
      'rationale',
      'facts',
      'detected_at',
      'judged_at',
      ...PROVENANCE,
    ],
    [tables.claimVerdicts.detected_at, tables.claimVerdicts.id],
    // Judged after the change it rates; held back until it was judged.
    async (_db, at) =>
      and(lte(tables.claimVerdicts.detected_at, at), lte(tables.claimVerdicts.judged_at, at)),
  ),
  recipe_observations: plainTable(
    'recipe_observations',
    'What each thesis recipe read from its public source (layers/terminal/server/theses/recipes/): one row per recipe, key and date, with the value, the fields kept beside it, and the R2 key of the raw bytes.',
    tables.recipeObservations,
    [
      'id',
      'recipe_id',
      'company',
      'key',
      'date',
      'value',
      'payload',
      'raw_key',
      'first_seen_at',
      ...PROVENANCE,
    ],
    // id last: (recipe_id, key, date) is not unique, and a keyset needs a key that is.
    [
      tables.recipeObservations.recipe_id,
      tables.recipeObservations.key,
      tables.recipeObservations.date,
      tables.recipeObservations.id,
    ],
    'a recipe observation is rewritten in place when a re-read gives a different value, and the value it replaced is not kept.',
    undefined,
    { recipe_id: tables.recipeObservations.recipe_id },
  ),
  source_runs: plainTable(
    'source_runs',
    'One row per poll tick and source: what was attempted and the outcome. No fetched_at column; a failed run fetched nothing.',
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
    [tables.sourceRuns.started_at, tables.sourceRuns.id],
    byColumn(tables.sourceRuns.started_at),
    loggedTotal(tables.sourceStats.run_count),
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

async function* pages(db: PipelineDb, table: ExportTable, where?: SQL): AsyncGenerator<Row[]> {
  let after: Row | null = null
  for (;;) {
    const rows = await table.page(db, after, EXPORT_PAGE_SIZE, where)
    if (rows.length === 0) return
    yield rows
    if (rows.length < EXPORT_PAGE_SIZE) return
    after = rows.at(-1)!
  }
}

export async function* csvChunks(
  db: PipelineDb,
  table: ExportTable,
  where?: SQL,
): AsyncGenerator<string> {
  yield csvLine(table.columns)
  for await (const rows of pages(db, table, where)) {
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
  for await (const rows of pages(db, table, where)) {
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
