// The terminal's numbers on GET /api/fleet: what the pipeline has stored and
// when it last ran, as plain counts. Registered into core's `extra` section from
// layers/terminal/server/plugins/fleet-counters.ts, so core's fleet-status.ts
// never imports the product's tables.

import { and, count, eq, max, ne, sql } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

import * as tables from '#server/db/schema'
import type { ExtensionDb } from '#server/utils/extensions'

import { launchCoverage } from '../pipeline/launch-watch'
import { countConfirmed } from './subscribers'

export async function collectTerminalCounters(
  db: ExtensionDb,
  now: Date,
): Promise<Record<string, number>> {
  const total = async (table: SQLiteTable) => {
    const [row] = await db.select({ total: count() }).from(table)
    return row?.total ?? 0
  }
  // From source_stats: count(*) over snapshots reads every row ever taken.
  const snapshotTotal = async () => {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${tables.sourceStats.snapshot_count}), 0)` })
      .from(tables.sourceStats)
    return row?.total ?? 0
  }
  // Newest tick per scope that fetched anything at all (not 'failed'), and the
  // newest failure — as epoch ms because `extra` is numbers only. 0 = never.
  const lastTick = async (scope: string, failed: boolean) => {
    const [row] = await db
      .select({ at: max(tables.sourceRuns.started_at) })
      .from(tables.sourceRuns)
      .where(
        and(
          scope ? eq(tables.sourceRuns.scope, scope) : undefined,
          failed ? eq(tables.sourceRuns.status, 'failed') : ne(tables.sourceRuns.status, 'failed'),
        ),
      )
    return row?.at ? Date.parse(row.at) : 0
  }

  const coverage = await launchCoverage(db, now)

  return {
    snapshots: await snapshotTotal(),
    entities: await total(tables.entities),
    changes: await total(tables.changes),
    alerts: await total(tables.alerts),
    lastOkTickEdgarMs: await lastTick('edgar', false),
    lastOkTickSurveyMs: await lastTick('survey', false),
    lastFailureMs: await lastTick('', true),
    lastTripwireRunMs: await lastTick('tripwire', false),
    launchStaleCells: coverage.stale_cells.length,
    subscribersConfirmed: await countConfirmed(db),
  }
}
