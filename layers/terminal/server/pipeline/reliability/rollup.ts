// The daily rollup of source_runs behind /data#reliability: one row per
// (source, UTC day) and one per poll tick. source_runs grows by ~1,000 rows a
// day for good; the page reads ~150 rollup rows a day of history instead.
//
// Incremental. Each run re-rolls from the start of the newest day already
// rolled (that day may have gained runs since), and a day's longest gap is
// measured from the previous good run whatever day it fell on, which the
// rollup itself supplies. The first run backfills at most MAX_DAYS_PER_RUN
// days of history and the next ones carry on from there.

import { and, gte, lt, max, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { GOOD_RUN_STATUSES } from '../../../shared/utils/terminal-reliability'
import { chunk, rowsPerStatement, runStatements, type PipelineDb } from '../store'

const DAY_MS = 86_400_000

/** How far back the first run reaches, and how long rolled rows are kept. */
export const ROLLUP_RETAIN_DAYS = 120
/** Days rolled in one invocation, so a backfill never holds months of runs in memory at once. */
export const MAX_DAYS_PER_RUN = 21

const GOOD = new Set<string>(GOOD_RUN_STATUSES)

export interface RunPoint {
  source_id: string
  scope: string
  started_at: string
  status: string
}

export interface DayRoll {
  source_id: string
  day: string
  runs: number
  good: number
  first_good_at: string | null
  last_good_at: string | null
  last_run_at: string
  longest_gap_ms: number | null
  gap_from: string | null
  gap_to: string | null
}

export interface TickRoll {
  scope: string
  started_at: string
  runs: number
  good: number
}

export const dayOf = (iso: string): string => iso.slice(0, 10)

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/**
 * Fold runs into day and tick rows. `lastGoodBefore` is each source's newest
 * good run before the first day given, so a gap that spans midnight, or a
 * week of failures, is charged to the day it ended. A skipped run (no secret
 * configured, nothing attempted) counts nowhere.
 */
export function rollRuns(
  runs: readonly RunPoint[],
  lastGoodBefore: ReadonlyMap<string, string> = new Map(),
): { days: DayRoll[]; ticks: TickRoll[] } {
  const sorted = runs
    .filter((r) => r.status !== 'skipped')
    .sort(
      (a, b) => a.source_id.localeCompare(b.source_id) || a.started_at.localeCompare(b.started_at),
    )
  const days = new Map<string, DayRoll>()
  const ticks = new Map<string, TickRoll>()
  const prevGood = new Map(lastGoodBefore)

  for (const run of sorted) {
    const good = GOOD.has(run.status)
    const day = dayOf(run.started_at)
    const key = `${run.source_id}\u0000${day}`
    let roll = days.get(key)
    if (!roll) {
      roll = {
        source_id: run.source_id,
        day,
        runs: 0,
        good: 0,
        first_good_at: null,
        last_good_at: null,
        last_run_at: run.started_at,
        longest_gap_ms: null,
        gap_from: null,
        gap_to: null,
      }
      days.set(key, roll)
    }
    roll.runs++
    roll.last_run_at = run.started_at

    const tickKey = `${run.scope}\u0000${run.started_at}`
    const tick = ticks.get(tickKey) ?? {
      scope: run.scope,
      started_at: run.started_at,
      runs: 0,
      good: 0,
    }
    tick.runs++
    ticks.set(tickKey, tick)
    if (!good) continue

    tick.good++
    roll.good++
    roll.first_good_at ??= run.started_at
    roll.last_good_at = run.started_at
    const before = prevGood.get(run.source_id)
    if (before) {
      const gap = Date.parse(run.started_at) - Date.parse(before)
      if (roll.longest_gap_ms === null || gap > roll.longest_gap_ms) {
        roll.longest_gap_ms = gap
        roll.gap_from = before
        roll.gap_to = run.started_at
      }
    }
    prevGood.set(run.source_id, run.started_at)
  }
  return {
    days: [...days.values()],
    ticks: [...ticks.values()].sort((a, b) => a.started_at.localeCompare(b.started_at)),
  }
}

export interface RollupReport {
  from: string | null
  through: string | null
  days: number
  ticks: number
  /** True when history is left over for the next run. */
  behind: boolean
}

/** Roll whatever source_runs holds past the rollup's newest day, up to MAX_DAYS_PER_RUN days of it. */
export async function rollSourceRuns(db: PipelineDb, now: Date): Promise<RollupReport> {
  const today = dayOf(now.toISOString())
  const floor = addDays(today, -ROLLUP_RETAIN_DAYS)
  const [[rolled], [first]] = await Promise.all([
    db.select({ day: max(tables.sourceRunDays.day) }).from(tables.sourceRunDays),
    // The oldest run is the first row of the (started_at, id) index.
    db
      .select({ at: tables.sourceRuns.started_at })
      .from(tables.sourceRuns)
      .where(gte(tables.sourceRuns.started_at, floor))
      .orderBy(tables.sourceRuns.started_at)
      .limit(1),
  ])
  if (!first) return { from: null, through: null, days: 0, ticks: 0, behind: false }
  const start = rolled?.day && rolled.day >= floor ? rolled.day : dayOf(first.at)
  const end = addDays(start, MAX_DAYS_PER_RUN)
  const behind = end <= today

  const [runs, prior] = await Promise.all([
    db
      .select({
        source_id: tables.sourceRuns.source_id,
        scope: tables.sourceRuns.scope,
        started_at: tables.sourceRuns.started_at,
        status: tables.sourceRuns.status,
      })
      .from(tables.sourceRuns)
      .where(
        and(
          gte(tables.sourceRuns.started_at, `${start}T00:00:00.000Z`),
          lt(tables.sourceRuns.started_at, `${end}T00:00:00.000Z`),
        ),
      ),
    db
      .select({
        source_id: tables.sourceRunDays.source_id,
        at: max(tables.sourceRunDays.last_good_at),
      })
      .from(tables.sourceRunDays)
      .where(and(lt(tables.sourceRunDays.day, start), gte(tables.sourceRunDays.day, floor)))
      .groupBy(tables.sourceRunDays.source_id),
  ])
  const lastGood = new Map(
    prior.filter((p) => p.at !== null).map((p) => [p.source_id, p.at!] as const),
  )
  const { days, ticks } = rollRuns(runs, lastGood)
  const rolledAt = now.toISOString()

  const dayRows = days.map((d) => ({ ...d, rolled_at: rolledAt }))
  const dayInserts = chunk(dayRows, rowsPerStatement(11)).map((group) =>
    db
      .insert(tables.sourceRunDays)
      .values(group)
      .onConflictDoUpdate({
        target: [tables.sourceRunDays.source_id, tables.sourceRunDays.day],
        set: {
          runs: sql`excluded.runs`,
          good: sql`excluded.good`,
          first_good_at: sql`excluded.first_good_at`,
          last_good_at: sql`excluded.last_good_at`,
          last_run_at: sql`excluded.last_run_at`,
          longest_gap_ms: sql`excluded.longest_gap_ms`,
          gap_from: sql`excluded.gap_from`,
          gap_to: sql`excluded.gap_to`,
          rolled_at: sql`excluded.rolled_at`,
        },
      }),
  )
  const tickInserts = chunk(ticks, rowsPerStatement(4)).map((group) =>
    db
      .insert(tables.pollTicks)
      .values(group)
      .onConflictDoUpdate({
        target: [tables.pollTicks.scope, tables.pollTicks.started_at],
        set: { runs: sql`excluded.runs`, good: sql`excluded.good` },
      }),
  )
  await runStatements(db, [
    ...dayInserts,
    ...tickInserts,
    db.delete(tables.sourceRunDays).where(lt(tables.sourceRunDays.day, floor)),
    db.delete(tables.pollTicks).where(lt(tables.pollTicks.started_at, floor)),
  ])
  return {
    from: start,
    through: runs.reduce<string | null>((m, r) => (m && m > r.started_at ? m : r.started_at), null),
    days: dayRows.length,
    ticks: ticks.length,
    behind,
  }
}
