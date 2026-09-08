// What /api/status and /api/fleet report, as functions that take the Drizzle
// client explicitly, so the workerd test suite can drive these against a real D1 and the
// two route handlers stay thin enough to have nothing in them worth testing.
//
// ── Migration drift ─────────────────────────────────────────────────────────
// The one signal here that has already cost an outage. `wrangler deploy` does
// not apply D1 migrations (CLAUDE.md › Gotchas), so a push that adds a column
// goes live before the column exists, and stays that way until someone
// remembers `bun run db:migrate:remote`. On 2026-08-21 that gap was seven
// minutes of a core route failing on a template fork. Seven minutes is luck,
// not a bound.
//
// Nothing on the Worker can close the gap — it has no way to run migrations
// from a request — but it CAN say it is open, which is what /api/status does:
// the repo's journal is bundled into the Worker at build time, the applied list
// is a table in D1, and the difference is the set of migrations production has
// never seen. A poller that reads `pending` sees the outage the moment it
// starts rather than when a user reports it.
//
// Two tables, because two tools record migrations. `bun run db:migrate:remote`
// (wrangler) writes `d1_migrations`; the generated .output wrangler.json names
// `_hub_migrations` instead, and both work — which is exactly why this reads
// whichever one exists rather than assuming.

import { and, count, eq, gt, isNull, max, ne, sql } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

import journal from '../db/migrations/meta/_journal.json'
import * as tables from '../db/schema'

/** The Drizzle client, passed in explicitly. */
export type FleetDb = ReturnType<typeof drizzle<typeof tables>>

/** Where a migration tool records what it applied, in the order they are tried. */
export const MIGRATION_TABLES = ['d1_migrations', '_hub_migrations'] as const
export type MigrationTable = (typeof MIGRATION_TABLES)[number]

/** Migration tags in the repository, oldest first, from drizzle-kit's journal. */
export function repoMigrations(): string[] {
  return journal.entries.map((entry) => entry.tag)
}

export interface AppliedMigrations {
  /** Which table answered, or null when neither exists — a database never migrated. */
  table: MigrationTable | null
  /** Migration names as recorded, oldest first. Wrangler stores the filename. */
  names: string[]
}

/**
 * What production has applied. Tries each known tracking table; a table that
 * does not exist is an error from D1, which is the expected case for the one
 * not in use, so it is caught and the next is tried. Any other failure is
 * also reported as "nothing applied" rather than thrown — this runs on a
 * public liveness route, and a liveness route that 500s on an unexpected
 * schema is measuring the wrong thing.
 */
export async function readAppliedMigrations(db: FleetDb): Promise<AppliedMigrations> {
  for (const table of MIGRATION_TABLES) {
    try {
      const rows = await db.all<{ name: string }>(
        sql`SELECT name FROM ${sql.identifier(table)} ORDER BY id`,
      )
      return { table, names: rows.map((row) => row.name) }
    } catch {
      // Not this table — try the next.
    }
  }
  return { table: null, names: [] }
}

export interface MigrationDrift {
  /** In the repo, never applied. Non-empty is the outage-in-waiting. */
  pending: string[]
  /** Applied, but not in the repo — a migration deleted or renamed after it shipped. */
  unknown: string[]
}

/**
 * Repo vs applied. Pure, so the rule is testable without a database.
 * Wrangler records `0003_name.sql` where the journal says `0003_name`; both
 * spellings are normalised to the tag.
 */
export function compareMigrations(repoTags: string[], appliedNames: string[]): MigrationDrift {
  const applied = new Set(appliedNames.map(tagOf))
  const repo = new Set(repoTags.map(tagOf))
  return {
    pending: [...repo].filter((tag) => !applied.has(tag)),
    unknown: [...applied].filter((tag) => !repo.has(tag)),
  }
}

function tagOf(name: string): string {
  return name.replace(/\.sql$/, '')
}

// ── Counters for /api/fleet ─────────────────────────────────────────────────
//
// Everything a portfolio dashboard wants to put on a card, in one query-light
// call. Counts only — no rows, no ids — so the payload is safe to store for
// months in someone else's database. `extra` is where the data pipeline adds
// its own (snapshots taken, sources fetched, …): add to this function rather
// than inventing a second endpoint, so one token and one route cover the fleet.

const DAY_MS = 24 * 60 * 60 * 1000

export interface FleetCounters {
  opsEvents: { pending: number; last24h: number }
  extra: Record<string, number>
}

export async function collectFleetCounters(db: FleetDb, now = new Date()): Promise<FleetCounters> {
  const dayAgo = new Date(now.getTime() - DAY_MS)

  const [pendingOps] = await db
    .select({ total: count() })
    .from(tables.opsEvents)
    .where(isNull(tables.opsEvents.notifiedAt))
  const [recentOps] = await db
    .select({ total: count() })
    .from(tables.opsEvents)
    .where(and(gt(tables.opsEvents.createdAt, dayAgo)))

  const total = async (table: SQLiteTable) => {
    const [row] = await db.select({ total: count() }).from(table)
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

  return {
    opsEvents: { pending: pendingOps?.total ?? 0, last24h: recentOps?.total ?? 0 },
    extra: {
      snapshots: await total(tables.snapshots),
      entities: await total(tables.entities),
      changes: await total(tables.changes),
      alerts: await total(tables.alerts),
      lastOkTickEdgarMs: await lastTick('edgar', false),
      lastOkTickSurveyMs: await lastTick('survey', false),
      lastFailureMs: await lastTick('', true),
    },
  }
}

/** Newest fetched_at per source — the freshness a reader of /api/status wants. */
export async function latestFetchBySource(db: FleetDb): Promise<Record<string, string>> {
  const rows = await db
    .select({ source_id: tables.snapshots.source_id, at: max(tables.snapshots.fetched_at) })
    .from(tables.snapshots)
    .groupBy(tables.snapshots.source_id)
  const out: Record<string, string> = {}
  for (const row of rows) if (row.at) out[row.source_id] = row.at
  return out
}
