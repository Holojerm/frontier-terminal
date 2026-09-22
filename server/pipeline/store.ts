import { and, desc, eq, inArray } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import type { BatchItem } from 'drizzle-orm/batch'
import type { z } from 'zod'

import * as tables from '../db/schema'
import {
  EntityRow,
  tableSchemas,
  type ChangeRow,
  type SourceRunRow,
  type StoredEntityRow,
  type TableName,
} from './contracts'

// The write chokepoint. Every pipeline row reaches D1 through insertRows(),
// which validates it against its zod contract first — so a row missing
// source_url or fetched_at cannot be stored, whatever produced it. The NOT
// NULL columns in server/db/schema.ts are the second layer, not the first.
//
// Every function takes the Drizzle client explicitly so the workerd suite
// can drive it against a real D1 binding (the same shape server/utils/ops.ts
// uses).

export type PipelineDb = ReturnType<typeof drizzle<typeof tables>>

/**
 * D1 rejects a statement with more than 100 bound parameters, so a multi-row
 * INSERT is chunked by rows × columns, not by rows. Miniflare does not
 * enforce the limit, which is why this is a named constant with its own test
 * rather than something the suite would catch.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
export const D1_MAX_BOUND_PARAMS = 100

/** Statements per db.batch() call. Not a documented D1 limit; keeps one
 * request's SQL well under the 100 KB statement ceiling for wide rows. */
export const D1_BATCH_STATEMENTS = 50

const STORE_TABLES = {
  snapshots: tables.snapshots,
  entities: tables.entities,
  changes: tables.changes,
  alerts: tables.alerts,
  source_runs: tables.sourceRuns,
} as const

export type StoreRow<T extends TableName> = z.output<(typeof tableSchemas)[T]>

export class StoreValidationError extends Error {
  constructor(
    readonly table: TableName,
    readonly index: number,
    readonly issues: string,
  ) {
    super(`${table}[${index}] rejected: ${issues}`)
    this.name = 'StoreValidationError'
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
}

/** Every row against the table's contract, or a StoreValidationError naming
 * the first offender. Nothing is returned partially validated. */
export function validateRows<T extends TableName>(
  table: T,
  rows: readonly unknown[],
): StoreRow<T>[] {
  const schema = tableSchemas[table]
  return rows.map((row, index) => {
    const parsed = schema.safeParse(row)
    if (!parsed.success) throw new StoreValidationError(table, index, formatIssues(parsed.error))
    return parsed.data as StoreRow<T>
  })
}

/** Rows per INSERT so that rows × columns stays within D1's bound-parameter cap. */
export function rowsPerStatement(columns: number): number {
  if (columns <= 0) throw new Error('a row needs at least one column')
  return Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columns))
}

export function chunk<R>(rows: readonly R[], size: number): R[][] {
  const out: R[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

type Statement = BatchItem<'sqlite'>

/** Run statements in as few round trips as D1 allows; one statement runs
 * directly rather than through a one-item batch. */
export async function runStatements(db: PipelineDb, statements: readonly Statement[]) {
  for (const group of chunk(statements, D1_BATCH_STATEMENTS)) {
    if (group.length === 1) {
      await group[0]
    } else {
      await db.batch(group as unknown as [Statement, ...Statement[]])
    }
  }
}

/** Validated multi-row INSERTs for one table, chunked under the bound-parameter cap. */
function insertStatements<T extends TableName>(
  db: PipelineDb,
  table: T,
  rows: readonly unknown[],
): Statement[] {
  const validated = validateRows(table, rows)
  if (validated.length === 0) return []
  const columns = Object.keys(validated[0]!).length
  const target = STORE_TABLES[table]
  return chunk(validated, rowsPerStatement(columns)).map((group) =>
    db.insert(target).values(group as unknown as (typeof target)['$inferInsert'][]),
  )
}

/**
 * Validate, then insert. Returns the number of rows written. Plain INSERT on
 * purpose — a primary-key collision (two ticks writing the same change id)
 * fails loudly and becomes a 'failed' source run, which is the honest record
 * of a lock race; the KV mutex in lock.ts is what prevents it.
 */
export async function insertRows<T extends TableName>(
  db: PipelineDb,
  table: T,
  rows: readonly unknown[],
): Promise<number> {
  const statements = insertStatements(db, table, rows)
  await runStatements(db, statements)
  return statements.length === 0 ? 0 : rows.length
}

/** The current entity set for one source, as contract rows (store-only
 * columns dropped) so it can go straight into diff(). */
export async function currentEntities(db: PipelineDb, sourceId: string): Promise<EntityRow[]> {
  const rows = await db
    .select()
    .from(tables.entities)
    .where(eq(tables.entities.source_id, sourceId))
  return rows.map(({ source_id: _source, first_seen_at: _first, ...row }) => EntityRow.parse(row))
}

/** Rewrite the content of entities whose hash changed. first_seen_at is left
 * alone: it belongs to the row's first appearance, not its latest edit. */
function updateEntityStatements(
  db: PipelineDb,
  sourceId: string,
  rows: readonly EntityRow[],
): Statement[] {
  return rows
    .map((row) => EntityRow.parse(row))
    .map((row) =>
      db
        .update(tables.entities)
        .set({
          entity_type: row.entity_type,
          provider: row.provider,
          content_hash: row.content_hash,
          payload: row.payload,
          snapshot_id: row.snapshot_id,
          source_url: row.source_url,
          fetched_at: row.fetched_at,
        })
        .where(
          and(
            eq(tables.entities.source_id, sourceId),
            eq(tables.entities.entity_key, row.entity_key),
          ),
        ),
    )
}

/** Drop entities a set-typed source no longer lists. */
function deleteEntityStatements(
  db: PipelineDb,
  sourceId: string,
  entityKeys: readonly string[],
): Statement[] {
  // One parameter per key plus one for source_id.
  return chunk(entityKeys, D1_MAX_BOUND_PARAMS - 1).map((keys) =>
    db
      .delete(tables.entities)
      .where(
        and(eq(tables.entities.source_id, sourceId), inArray(tables.entities.entity_key, keys)),
      ),
  )
}

export interface DiffWrites {
  added: readonly StoredEntityRow[]
  modified: readonly EntityRow[]
  removed: readonly string[]
  changes: readonly ChangeRow[]
  alerts: readonly unknown[]
}

/**
 * One tick's diff, applied as a single db.batch() — which D1 runs as one
 * transaction. The entity set and the change log must move together: entities
 * written without their change rows make the next tick diff to nothing, so the
 * change (and any alert on it) is lost for good. All or nothing means a failed
 * write is retried whole by the next tick.
 */
export async function applyDiff(db: PipelineDb, sourceId: string, writes: DiffWrites) {
  const statements = [
    ...insertStatements(db, 'entities', writes.added),
    ...updateEntityStatements(db, sourceId, writes.modified),
    ...deleteEntityStatements(db, sourceId, writes.removed),
    ...insertStatements(db, 'changes', writes.changes),
    ...insertStatements(db, 'alerts', writes.alerts),
  ]
  if (statements.length === 0) return
  await db.batch(statements as unknown as [Statement, ...Statement[]])
}

/**
 * When this source was last recorded 'skipped', or null. The refresh uses it
 * to say "not configured" in the ops digest once a day rather than once a
 * tick: the digest is for things that changed, and an unset secret does not
 * change four times a day.
 */
export async function lastSkippedRunAt(db: PipelineDb, sourceId: string): Promise<string | null> {
  const [row] = await db
    .select({ at: tables.sourceRuns.started_at })
    .from(tables.sourceRuns)
    .where(and(eq(tables.sourceRuns.source_id, sourceId), eq(tables.sourceRuns.status, 'skipped')))
    .orderBy(desc(tables.sourceRuns.started_at))
    .limit(1)
  return row?.at ?? null
}

/**
 * The status of this source's most recent run, or null before its first.
 *
 * The refresh uses it to raise `source_absent` on the transition only. Five
 * OpenAI SKUs are priced with no model page behind them and never will be;
 * a digest that repeats that every survey tick is training its reader to
 * archive the mail unopened, which costs the tick where a page that did
 * exist stops existing.
 */
export async function lastRunStatus(db: PipelineDb, sourceId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: tables.sourceRuns.status })
    .from(tables.sourceRuns)
    .where(eq(tables.sourceRuns.source_id, sourceId))
    .orderBy(desc(tables.sourceRuns.started_at))
    .limit(1)
  return row?.status ?? null
}

export interface GoodSnapshot {
  id: string
  content_hash: string
  raw_key: string
}

/**
 * The snapshot behind a source's newest non-failed run. Read through
 * source_runs rather than snapshots directly because the run row is written
 * last: a tick that stored a snapshot and then died before its entity writes
 * has no run row, so the next tick sees a different "latest" hash and parses
 * again instead of skipping a half-applied payload as 'unchanged'.
 */
export async function latestGoodSnapshot(
  db: PipelineDb,
  sourceId: string,
): Promise<GoodSnapshot | null> {
  const good: SourceRunRow['status'][] = ['ok', 'unchanged', 'baseline']
  const [row] = await db
    .select({
      id: tables.snapshots.id,
      content_hash: tables.snapshots.content_hash,
      raw_key: tables.snapshots.raw_key,
    })
    .from(tables.sourceRuns)
    .innerJoin(tables.snapshots, eq(tables.snapshots.id, tables.sourceRuns.snapshot_id))
    .where(and(eq(tables.sourceRuns.source_id, sourceId), inArray(tables.sourceRuns.status, good)))
    .orderBy(desc(tables.sourceRuns.started_at))
    .limit(1)
  return row ?? null
}
