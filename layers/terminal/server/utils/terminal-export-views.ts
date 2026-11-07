// The shape of an export table and the parts every table in EXPORT_TABLES
// (terminal-export.ts) is built from: column docs, the entity, parts and
// exposure views, and static tables.

import { and, asc, count, eq, lt, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'

import * as tables from '#server/db/schema'
import { HISTORY_PARAM } from '#shared/utils/license'
import type { DictionaryType } from '../../shared/utils/terminal-types'
import type { PipelineDb } from '../pipeline/store'
import { AS_OF_PARAM, PointInTimeError, rewindEntities } from './terminal-asof'
import { buildSeries } from '../exposure/series'
import { filedBefore } from './terminal-exposure'
import { byString } from './terminal-json'

/**
 * Rows per D1 read, for /export and the bulk build alike. D1 refuses an
 * invocation's queries past 1,000, so a smaller page would cap a
 * `?history=full` export at that many pages.
 */
export const EXPORT_PAGE_SIZE = 1_000

export type Row = Record<string, unknown>

export interface ExportTable {
  name: string
  description: string
  columns: readonly string[]
  /**
   * What each column holds, for the data dictionary and the Parquet types.
   * Every column but the license column a full-history cut adds.
   */
  docs: ColumnDocs
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
export type WrittenBy = (db: PipelineDb, at: string) => Promise<SQL | undefined>

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

/** One column in the data dictionary (/export/dictionary.json). */
export interface ColumnDoc {
  type: DictionaryType
  meaning: string
  unit?: string
  nullable?: true
  /** Part of the row's unique key. */
  key?: true
  /** Where and when the row was read. */
  provenance?: true
}

/** A table's columns, in export order, each with its dictionary entry. */
export type ColumnDocs = Readonly<Record<string, ColumnDoc>>

export const PROVIDER: ColumnDoc = {
  type: 'text',
  meaning:
    'The lab the row belongs to: openai, anthropic, google, xai, meta, mistral, deepseek, alibaba, moonshot, or other.',
}

export const SOURCE_NAME: ColumnDoc = {
  type: 'text',
  meaning:
    'The source the row was read from, as sources.yaml names it. The Coverage panel lists each with its URL.',
}

/** In an entity view the source is part of the key: two pages can list the same entity. */
const SOURCE_ID: ColumnDoc = { ...SOURCE_NAME, key: true }

export const CIK: ColumnDoc = {
  type: 'text',
  meaning: 'The filer’s SEC CIK, ten digits, zero-padded.',
}

export const entityKey = (shape: string, more = ''): ColumnDoc => ({
  type: 'text',
  key: true,
  meaning: `The row’s key across polls, ${shape}. With source_id it identifies the row.${more}`,
})

export const filingKey = (shape: string): ColumnDoc => ({
  type: 'text',
  key: true,
  meaning: `The filing’s entity, ${shape}. With source_id and part it identifies the row.`,
})

/** The trailing columns every entity view shares. */
const ENTITY_TAIL = {
  content_hash: {
    type: 'text',
    meaning:
      'SHA-256 (hex) of the row’s content. It changes when the content does, and each change is a row in changes.',
  },
  snapshot_id: {
    type: 'text',
    meaning: 'The snapshots.id of the fetch whose parse produced the row’s current content.',
  },
  first_seen_at: {
    type: 'timestamp',
    meaning: 'When a fetch first produced the row, in UTC. It never changes.',
  },
  source_url: {
    type: 'text',
    provenance: true,
    meaning: 'The URL the row’s current content was read from.',
  },
  fetched_at: {
    type: 'timestamp',
    provenance: true,
    meaning:
      'When the fetch that produced the row’s current content ran, in UTC. A later fetch that finds the same content doesn’t move it. source_runs has every check.',
  },
} satisfies ColumnDocs

/** The column an entity view gains when rebuilt as of T, before its provenance. */
export const AS_OF_VERIFIED = 'as_of_verified'

export const AS_OF_VERIFIED_DOC: ColumnDoc = {
  type: 'boolean',
  meaning:
    'With ?as_of= only. False where the newest change at or before as_of disagrees with the rebuilt row, so the row may not be what the store held then.',
}

/** The columns `table` serves as of T: a rebuilt view gains AS_OF_VERIFIED before its provenance pair. */
export function asOfColumns(table: Pick<ExportTable, 'columns' | 'pointInTime'>): string[] {
  if (table.pointInTime !== 'rebuilt') return [...table.columns]
  return [...table.columns.slice(0, -2), AS_OF_VERIFIED, ...table.columns.slice(-2)]
}

/** The leading columns of every registration-statement view, after part (FILING_FIELDS). */
const FILING_DOCS = {
  cik: { ...CIK, meaning: 'The registrant’s SEC CIK, ten digits, zero-padded.' },
  entity_name: { type: 'text', meaning: 'The registrant’s name as the filing prints it.' },
  accession_no: { type: 'text', meaning: 'The registration filing’s EDGAR accession number.' },
  form: { type: 'text', meaning: 'The filing’s form type: S-1 or S-1/A.' },
  filed: { type: 'date', meaning: 'The day the filing was filed with the SEC.' },
} satisfies ColumnDocs

export const usd = 'USD'
const perMtok = 'USD per million tokens'

export const price = (what: string): ColumnDoc => ({
  type: 'number',
  unit: perMtok,
  nullable: true,
  meaning: `List price of ${what}. Null where the page prints none.`,
})

/** A string the source prints, kept as printed; `nullWhen` makes it nullable and says when. */
export const verbatim = (what: string, nullWhen?: string): ColumnDoc => ({
  type: 'text',
  meaning: `${what}, verbatim${nullWhen ? `. Null ${nullWhen}` : ''}.`,
  ...(nullWhen ? { nullable: true as const } : {}),
})

export const changeHash = (side: 'before' | 'after', nullWhen: string): ColumnDoc => ({
  type: 'text',
  nullable: true,
  meaning: `The row’s content_hash ${side} the change. Null when ${nullWhen}.`,
})

export const changeJson = (side: 'before' | 'after', nullWhen: string): ColumnDoc => ({
  type: 'json',
  nullable: true,
  meaning: `JSON text (a string in the JSON export too): the row’s content ${side} the change. Null when ${nullWhen}.`,
})

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
export function project(row: Row, columns: readonly string[]): Row {
  const out: Row = {}
  for (const column of columns) out[column] = row[column] ?? null
  return out
}

export function entityView(
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
  key: ColumnDoc,
  fields: ColumnDocs,
): ExportTable {
  const docs: ColumnDocs = {
    entity_key: key,
    source_id: SOURCE_ID,
    provider: PROVIDER,
    ...fields,
    ...ENTITY_TAIL,
  }
  const columns = Object.keys(docs)
  const ofType = eq(tables.entities.entity_type, entityType)
  const order = [tables.entities.source_id, tables.entities.entity_key] as const
  const view = { name, description, columns, docs }
  return {
    ...view,
    async at(db, at) {
      // The current set is the view; as of T it is rebuilt in memory (one
      // type's rows and change log) and paged by the same keyset.
      const rewound = await rewindEntities(db, entityType, at)
      const unverified = new Set(rewound.unverified)
      const columnsAt = asOfColumns({ columns, pointInTime: 'rebuilt' })
      const rows = rewound.rows.map(({ payload, ...rest }) =>
        project(
          {
            ...parsePayload(payload),
            ...rest,
            [AS_OF_VERIFIED]: !unverified.has(rest.entity_key),
          },
          columnsAt,
        ),
      )
      const keyOf = (r: Row) => [String(r.source_id), String(r.entity_key)] as const
      return {
        name,
        description,
        columns: columnsAt,
        docs: { ...docs, [AS_OF_VERIFIED]: AS_OF_VERIFIED_DOC },
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
        .where(and(ofType, afterKey(order, after)))
        .orderBy(...order.map((c) => asc(c)))
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
export function partsView<C>(
  name: string,
  description: string,
  entityType: 'statement' | 'commitment' | 'concentration' | 'shares' | 'risk_factors',
  key: ColumnDoc,
  fields: ColumnDocs,
  explode: (payload: Row, context: C) => Row[],
  prepare: (db: PipelineDb) => Promise<C>,
): ExportTable {
  const docs: ColumnDocs = {
    entity_key: key,
    source_id: SOURCE_ID,
    provider: { ...PROVIDER, meaning: 'The lab that filed the registration statement.' },
    part: {
      type: 'integer',
      key: true,
      meaning: 'The row’s position within its entity, from 0, in the order the filing prints it.',
    },
    ...FILING_DOCS,
    ...fields,
    first_seen_at: ENTITY_TAIL.first_seen_at,
    source_url: {
      type: 'text',
      provenance: true,
      meaning: 'The registration document on EDGAR the row was read from.',
    },
    fetched_at: ENTITY_TAIL.fetched_at,
  }
  const columns = Object.keys(docs)
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
    docs,
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

const FILING_FIELDS = Object.keys(FILING_DOCS)
export const filing = (p: Row): Row =>
  Object.fromEntries(FILING_FIELDS.map((f) => [f, p[f] ?? null]))
export const list = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : [])
export const none = async () => null

/** Per filing, the previous filing's risk-factor headings by the same filer. */
export async function priorHeadings(db: PipelineDb): Promise<Map<string, Row>> {
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

export type Sections = { title: string; headings: string[] }[]

export function plainTable(
  name: string,
  description: string,
  table: SQLiteTable,
  docs: ColumnDocs,
  key: Key,
  writtenBy: WrittenBy | string,
  total?: SQL<number>,
  filters?: Readonly<Record<string, SQLiteColumn>>,
  /** Rows this export never serves, whatever the request asks for. */
  scope?: SQL,
): ExportTable {
  const columns = Object.keys(docs)
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
    docs,
    filters,
    page: pageWhere(undefined),
    async at(db, at) {
      if (typeof writtenBy === 'string') throw new PointInTimeError(writtenBy)
      const filter = await writtenBy(db, at)
      return {
        name,
        description,
        columns,
        docs,
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
export function staticTable<C extends string>(
  name: string,
  description: string,
  /** The row type's own column list (terminal-entities.ts, terminal-identifiers.ts) sets the order. */
  columns: readonly C[],
  docs: Readonly<Record<C, ColumnDoc>>,
  rows: readonly object[],
  asOfRefusal: string,
): ExportTable {
  return {
    name,
    description,
    columns,
    docs,
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

/**
 * Every exposure series point (layers/terminal/server/exposure/series.ts),
 * built in memory from filed_facts: a few thousand facts at most. As of T it
 * is built from the facts filed before T's UTC day.
 */
export function exposureView(name: string, description: string, docs: ColumnDocs): ExportTable {
  const columns = Object.keys(docs)
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
    columns,
    docs,
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
