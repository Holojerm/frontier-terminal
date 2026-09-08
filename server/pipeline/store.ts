import { and, desc, eq, inArray } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import type { BatchItem } from 'drizzle-orm/batch'
import type { z } from 'zod'

import * as tables from '../db/schema'
import { EntityRow, tableSchemas, type SourceRunRow, type TableName } from './contracts'

// The write chokepoint. Every pipeline row reaches D1 through insertRows(),
// which validates it against its zod contract first — so a row missing
// source_url or fetched_at cannot be stored, whatever produced it. This is
// the take-home's provenance gate, kept; the NOT NULL columns in
// server/db/schema.ts are the second layer, not the first.
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
  const validated = validateRows(table, rows)
  if (validated.length === 0) return 0
  const columns = Object.keys(validated[0]!).length
  const target = STORE_TABLES[table]
  const statements = chunk(validated, rowsPerStatement(columns)).map((group) =>
    db.insert(target).values(group as unknown as (typeof target)['$inferInsert'][]),
  )
  await runStatements(db, statements)
  return validated.length
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
export async function updateEntities(
  db: PipelineDb,
  sourceId: string,
  rows: readonly EntityRow[],
): Promise<number> {
  const validated = rows.map((row) => EntityRow.parse(row))
  const statements = validated.map((row) =>
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
  await runStatements(db, statements)
  return validated.length
}

/** Drop entities a set-typed source no longer lists. */
export async function deleteEntities(
  db: PipelineDb,
  sourceId: string,
  entityKeys: readonly string[],
): Promise<number> {
  // One parameter per key plus one for source_id.
  const statements = chunk(entityKeys, D1_MAX_BOUND_PARAMS - 1).map((keys) =>
    db
      .delete(tables.entities)
      .where(
        and(eq(tables.entities.source_id, sourceId), inArray(tables.entities.entity_key, keys)),
      ),
  )
  await runStatements(db, statements)
  return entityKeys.length
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
