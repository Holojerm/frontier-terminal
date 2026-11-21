// Reads of row_counts, the per-key row counters that triggers keep for the
// tables the coverage panel, the overview and the fleet endpoint count
// (layers/terminal/server/db/tables/pipeline.ts › rowCounts). In its own file so
// the fleet plugin does not load the query layer to read four numbers.

import { eq, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { ExtensionDb } from '#server/utils/extensions'
import type { PipelineDb } from '../pipeline/store'

type CountsDb = Pick<PipelineDb | ExtensionDb, 'select'>

export type CountedTable = 'entities' | 'changes' | 'alerts' | 'recipe_observations'

/**
 * A counted table's rows per key (see row_counts in the schema for each
 * table's key), from the counters its triggers keep. count(*) reads every row.
 * A key whose rows are all gone is left out, as a GROUP BY would leave it.
 */
export async function countsByKey(db: CountsDb, table: CountedTable): Promise<Map<string, number>> {
  const rows = await db
    .select({ key: tables.rowCounts.key, n: tables.rowCounts.n })
    .from(tables.rowCounts)
    .where(eq(tables.rowCounts.table_name, table))
  return new Map(rows.filter((r) => r.n > 0).map((r) => [r.key, r.n]))
}

/** Every counted table's total, in one read of the counters. */
export async function countedTotals(db: CountsDb): Promise<Record<CountedTable, number>> {
  const rows = await db
    .select({ table: tables.rowCounts.table_name, n: sql<number>`sum(${tables.rowCounts.n})` })
    .from(tables.rowCounts)
    .groupBy(tables.rowCounts.table_name)
  const of = (table: CountedTable) => rows.find((r) => r.table === table)?.n ?? 0
  return {
    entities: of('entities'),
    changes: of('changes'),
    alerts: of('alerts'),
    recipe_observations: of('recipe_observations'),
  }
}
