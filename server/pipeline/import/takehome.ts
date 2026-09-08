import type { BatchItem } from 'drizzle-orm/batch'

import * as tables from '../../db/schema'
import { AlertRow, ChangeRow, SnapshotRow } from '../contracts'
import { CONTENT_TYPES, rawKeyFor } from '../refresh'
import { chunk, rowsPerStatement, validateRows, type PipelineDb } from '../store'

// The take-home's history, shaped for this store. The laptop pipeline ran the
// same parsers against DuckDB from 2026-08-25 until cutover; its `make export`
// renders the store as CSV, and this module turns three of those files
// (snapshots, changes, alerts) into contract-validated rows plus the R2
// objects the snapshots point at. Pure: strings in, rows and statements out,
// so the workerd suite can run it against a real D1 and the bun CLI
// (scripts/import-takehome.ts) can render the same statements to a file for
// `wrangler d1 execute`. Nothing in the Worker imports it.
//
// Not imported: `entities` is the CURRENT row set the cron owns, and
// `source_runs` describe the laptop's ticks, not this Worker's.
//
// Idempotent by construction: every id is the take-home's, every INSERT is
// ON CONFLICT DO NOTHING, and the plan is computed against the ids already
// present so a re-run reports what it skipped instead of failing.

export interface TakehomeExport {
  /** CSV text of the export's snapshots, changes and alerts tables. */
  snapshots: string
  changes: string
  alerts: string
}

/** One R2 object a run of identical snapshots points at. The take-home kept a
 * single overwritten file per source, so the bytes exist on disk only for the
 * run whose content_hash the file still hashes to; the CLI checks. */
export interface RawObject {
  key: string
  /** Take-home-relative path from the export's raw_path column. */
  raw_path: string
  content_hash: string
  content_type: string
}

export type JudgeRunInsert = typeof tables.judgeRuns.$inferInsert

export interface ImportRows {
  snapshots: SnapshotRow[]
  changes: ChangeRow[]
  alerts: AlertRow[]
  rawObjects: RawObject[]
  /** The cursor row that keeps GET /api/judge/pending from re-offering the
   * imported history; null when the export has no changes. */
  judgeRun: JudgeRunInsert | null
}

export const IMPORT_TABLES = ['snapshots', 'changes', 'alerts', 'judge_runs'] as const
export type ImportTable = (typeof IMPORT_TABLES)[number]

export type ExistingIds = Readonly<Record<ImportTable, ReadonlySet<string>>>

export interface TablePlan<R> {
  insert: R[]
  skipped: number
}

export interface ImportPlan {
  snapshots: TablePlan<SnapshotRow>
  changes: TablePlan<ChangeRow>
  alerts: TablePlan<AlertRow>
  judge_runs: TablePlan<JudgeRunInsert>
}

/** Who wrote the cursor row — read back by /api/status and the judge tests. */
export const IMPORT_JUDGE_SOURCE = 'import'

// ── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180: quoted fields may hold commas, newlines and doubled quotes.
 * Returns one record per body row keyed by the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c !== '"') {
        field += c
      } else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else {
        quoted = false
      }
      continue
    }
    if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (quoted) throw new Error('csv: unterminated quoted field')
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  const [header, ...body] = rows
  if (!header) return []
  return body.map((cells, n) => {
    if (cells.length !== header.length) {
      throw new Error(`csv: row ${n + 1} has ${cells.length} fields, header has ${header.length}`)
    }
    return Object.fromEntries(header.map((name, i) => [name, cells[i]!]))
  })
}

// ── Timestamps ──────────────────────────────────────────────────────────────

// DuckDB renders a UTC TIMESTAMPTZ as `2026-08-25 22:16:44.99+00`, trimming
// trailing zeros from the fraction. The pipeline wrote Date.toISOString()
// values, so restoring three fraction digits gives back the exact string it
// stored — and keeps the column sortable as text next to the Worker's rows.
const DUCKDB_UTC = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:\+00(?::00)?|Z)$/

export function isoFromDuckDb(value: string): string {
  const m = DUCKDB_UTC.exec(value)
  if (!m) throw new Error(`not a UTC DuckDB timestamp: ${JSON.stringify(value)}`)
  return `${m[1]}T${m[2]}.${(m[3] ?? '').padEnd(3, '0')}Z`
}

/** A snapshot id is `<source_id>:<fetched_at>` as originally stamped, so it
 * carries the exact fetched_at even where the CSV lost the fraction. Used
 * when it names the same instant; the DuckDB rendering otherwise. */
function snapshotFetchedAt(row: Record<string, string>): string {
  const rendered = isoFromDuckDb(row.fetched_at!)
  const prefix = `${row.source_id}:`
  if (!row.id!.startsWith(prefix)) return rendered
  const stamped = row.id!.slice(prefix.length)
  return Date.parse(stamped) === Date.parse(rendered) ? stamped : rendered
}

// ── Rows ────────────────────────────────────────────────────────────────────

const nullable = (s: string): string | null => (s === '' ? null : s)
const intOrNull = (s: string): number | null => (s === '' ? null : Number(s))
const extOf = (path: string): string => path.match(/\.([^./]+)$/)?.[1] ?? 'raw'

/**
 * Snapshot rows with raw_key assigned the way the Worker assigns it: a fetch
 * whose content_hash equals the previous good fetch of the same source points
 * at the object already stored (server/pipeline/refresh.ts), so a source
 * checked 400 times with two distinct payloads yields two keys. Also returns
 * the object each run starts.
 */
function snapshotRows(csv: string): { snapshots: SnapshotRow[]; rawObjects: RawObject[] } {
  const records = parseCsv(csv).map((r) => ({ ...r, fetched_at: snapshotFetchedAt(r) }))
  records.sort((a, b) => a.fetched_at!.localeCompare(b.fetched_at!) || a.id!.localeCompare(b.id!))

  const last = new Map<string, { content_hash: string; raw_key: string }>()
  const rawObjects: RawObject[] = []
  const rows = records.map((r) => {
    const source_id = r.source_id!
    const previous = last.get(source_id)
    let raw_key: string
    if (previous && previous.content_hash === r.content_hash) {
      raw_key = previous.raw_key
    } else {
      const ext = extOf(r.raw_path!)
      raw_key = rawKeyFor({ source_id, url: r.source_url!, ext }, r.fetched_at!)
      rawObjects.push({
        key: raw_key,
        raw_path: r.raw_path!,
        content_hash: r.content_hash!,
        content_type: CONTENT_TYPES[ext] ?? 'text/plain',
      })
      last.set(source_id, { content_hash: r.content_hash!, raw_key })
    }
    return {
      id: r.id,
      source_id,
      content_hash: r.content_hash,
      raw_key,
      http_status: intOrNull(r.http_status!),
      bytes: intOrNull(r.bytes!),
      source_url: r.source_url,
      fetched_at: r.fetched_at,
    }
  })
  return { snapshots: validateRows('snapshots', rows), rawObjects }
}

function changeRows(csv: string): ChangeRow[] {
  const rows = parseCsv(csv).map((r) => ({
    id: r.id,
    entity_key: r.entity_key,
    entity_type: r.entity_type,
    provider: r.provider,
    change_type: r.change_type,
    before_hash: nullable(r.before_hash!),
    after_hash: nullable(r.after_hash!),
    before_json: nullable(r.before_json!),
    after_json: nullable(r.after_json!),
    detected_at: isoFromDuckDb(r.detected_at!),
    source_url: r.source_url,
    fetched_at: isoFromDuckDb(r.fetched_at!),
  }))
  return validateRows('changes', rows)
}

function alertRows(csv: string): AlertRow[] {
  const rows = parseCsv(csv).map((r) => ({
    id: r.id,
    severity: r.severity,
    headline: r.headline,
    explanation: r.explanation,
    change_ids: r.change_ids,
    rule: r.rule,
    created_at: isoFromDuckDb(r.created_at!),
    source_url: r.source_url,
    fetched_at: isoFromDuckDb(r.fetched_at!),
  }))
  return validateRows('alerts', rows)
}

/**
 * Parse and validate the export. Every row passes its zod contract — the
 * same gate server/pipeline/store.ts applies to the cron's rows — so a
 * take-home row this store would not have accepted never gets a statement.
 *
 * `now` stamps the judge run's started_at; injected so tests are comparable.
 */
export function parseTakehomeExport(csv: TakehomeExport, now: () => Date = () => new Date()) {
  const { snapshots, rawObjects } = snapshotRows(csv.snapshots)
  const changes = changeRows(csv.changes)
  const alerts = alertRows(csv.alerts)

  // Cursor semantics are server/pipeline/judge/pending.ts › judgedThrough:
  // a change is pending while its detected_at is newer than the newest
  // judged_through, so one row at the newest imported detected_at retires the
  // whole history. The take-home's judge already read these rows; its verdicts
  // are the alerts above.
  let judgeRun: JudgeRunInsert | null = null
  if (changes.length > 0) {
    const judged_through = changes
      .map((c) => c.detected_at)
      .sort()
      .at(-1)!
    judgeRun = {
      id: `import:takehome:${judged_through}`,
      started_at: now().toISOString(),
      judged_through,
      changes_seen: changes.length,
      accepted: 0,
      rejected: 0,
      rejection_reason: null,
      source: IMPORT_JUDGE_SOURCE,
    }
  }

  return { snapshots, changes, alerts, rawObjects, judgeRun } satisfies ImportRows
}

// ── Plan ────────────────────────────────────────────────────────────────────

function planTable<R extends { id: string }>(rows: readonly R[], present: ReadonlySet<string>) {
  const insert = rows.filter((r) => !present.has(r.id))
  return { insert, skipped: rows.length - insert.length } satisfies TablePlan<R>
}

/** What a run will write, given the ids each table already holds. */
export function planImport(rows: ImportRows, existing: ExistingIds): ImportPlan {
  return {
    snapshots: planTable(rows.snapshots, existing.snapshots),
    changes: planTable(rows.changes, existing.changes),
    alerts: planTable(rows.alerts, existing.alerts),
    judge_runs: planTable(rows.judgeRun ? [rows.judgeRun] : [], existing.judge_runs),
  }
}

export async function existingIds(db: PipelineDb): Promise<ExistingIds> {
  const [snapshots, changes, alerts, judge_runs] = await Promise.all([
    db.select({ id: tables.snapshots.id }).from(tables.snapshots),
    db.select({ id: tables.changes.id }).from(tables.changes),
    db.select({ id: tables.alerts.id }).from(tables.alerts),
    db.select({ id: tables.judgeRuns.id }).from(tables.judgeRuns),
  ])
  const set = (rows: { id: string }[]) => new Set(rows.map((r) => r.id))
  return {
    snapshots: set(snapshots),
    changes: set(changes),
    alerts: set(alerts),
    judge_runs: set(judge_runs),
  }
}

// ── Statements ──────────────────────────────────────────────────────────────

export type ImportStatement = BatchItem<'sqlite'> & {
  toSQL(): { sql: string; params: unknown[] }
}

/**
 * The plan as drizzle INSERT ... ON CONFLICT DO NOTHING statements, chunked
 * so rows × columns never exceeds D1's bound-parameter cap. The workerd suite
 * runs these through store.ts › runStatements; the CLI renders them with
 * renderStatement() and hands the file to wrangler.
 */
export function importStatements(db: PipelineDb, plan: ImportPlan): ImportStatement[] {
  const out: ImportStatement[] = []
  const add = <T extends (typeof tables)[keyof typeof tables]>(
    target: T,
    rows: readonly T['$inferInsert'][],
  ) => {
    if (rows.length === 0) return
    const columns = Object.keys(rows[0]!).length
    for (const group of chunk(rows, rowsPerStatement(columns))) {
      out.push(db.insert(target).values(group).onConflictDoNothing())
    }
  }
  add(tables.snapshots, plan.snapshots.insert)
  add(tables.changes, plan.changes.insert)
  add(tables.alerts, plan.alerts.insert)
  add(tables.judgeRuns, plan.judge_runs.insert)
  return out
}

/** The statement's SQL with every `?` replaced by a SQL literal, for a file
 * `wrangler d1 execute --file` can ingest. Only the scalar types the contracts
 * produce are accepted; anything else is a bug upstream, not a case to guess. */
export function renderStatement(statement: { toSQL(): { sql: string; params: unknown[] } }) {
  const { sql, params } = statement.toSQL()
  return inlineParams(sql, params)
}

export function inlineParams(sql: string, params: readonly unknown[]): string {
  const parts = sql.split('?')
  if (parts.length - 1 !== params.length) {
    throw new Error(`sql has ${parts.length - 1} placeholders but ${params.length} params`)
  }
  let out = parts[0]!
  for (let i = 0; i < params.length; i++) out += sqlLiteral(params[i]) + parts[i + 1]!
  return out
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  throw new Error(`cannot render a ${typeof value} as a SQL literal`)
}
