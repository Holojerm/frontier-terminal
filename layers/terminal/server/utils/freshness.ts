// Freshness checks: is each part of the pipeline still producing?
//
// The ops digest hears about failures because each pipeline records one
// (source_failed, bulk_build_failed, …). It hears nothing when a part simply
// stops: a cron that no longer fires, a run killed at the CPU limit, a job off
// the Worker (the judge routine, the GDELT Actions job) that nobody starts. On
// 2026-11-06 the GDELT job's GitHub schedule never fired, and four hours
// passed with no signal at all. These checks are that signal.
//
// One rule for every check. A check reads its own evidence:
//
//   owedSince  when work became owed and is still owed (null: nothing owed)
//   lastOkAt   the last success (null: never; undefined: nothing records one)
//
// and is stale when work has been owed for longer than maxAgeMs and nothing
// succeeded within maxAgeMs either. Owed work is what makes silence a problem:
// a judge with no changes to read, or a GDELT job with no due searches, is
// quiet because it should be. A stale check spools one ops event of its kind,
// then a KV marker holds the repeat to once every FRESHNESS_REPEAT_MS while
// it lasts. ops:watch runs every check each half hour.
//
// Two sources of checks, both built by freshnessChecks() in
// terminal-freshness.ts:
//
//   - one per scheduled task, from runtimeConfig.scheduledTasks and the
//     task_heartbeats table (task-heartbeat.ts), with the limit derived from
//     its cron: one missed run plus half an interval, at least 30 minutes;
//   - one per producer off the Worker, or per task whose heartbeat cannot say
//     enough, with its evidence read from the rows that producer writes;
//   - the deploy of main (pipeline/deploy-watch.ts).
//
// layers/terminal/test/freshness.test.ts fails the build when a scheduled task
// has no heartbeat and no check of its own, or a check's kind has no tier.

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import { logEvent } from '#server/utils/log'

import type { LockStore } from '../pipeline/lock'
import type { PipelineDb } from '../pipeline/store'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** A stale check is reported again this often while it stays stale. */
export const FRESHNESS_REPEAT_MS = 6 * HOUR_MS

/** The ops kind every scheduled task's check spools. */
export const TASK_SILENT_KIND = 'task_silent'

/** Spooled when a check's own evidence query throws; the other checks still run. */
export const FRESHNESS_CHECK_FAILED_KIND = 'freshness_check_failed'

export const freshnessMarkerKey = (key: string) => `freshness:notified:${key}`

export interface FreshnessEvidence {
  /** When work became owed and is still owed; null when nothing is owed now. */
  owedSince: string | null
  /** The last success; null when there has never been one; undefined when nothing records one. */
  lastOkAt?: string | null
  /** One line of context for the ops event, e.g. a task's last error. */
  note?: string | null
}

export interface FreshnessCheck {
  /** Stable id: the KV marker and the verdict map are keyed by it. */
  key: string
  /** What a reader of the digest calls it. */
  label: string
  /** The ops event kind it spools. Every kind needs a tier (terminal-ops-severity.ts). */
  kind: string
  maxAgeMs: number
  /** The route the ops event names, when one is the place to look. */
  path?: string
  evidence(db: PipelineDb, now: Date, marker: MarkerStore): Promise<FreshnessEvidence>
}

export type FreshnessVerdict =
  /** Something succeeded within the limit. */
  | 'fresh'
  /** Nothing has been owed for longer than the limit. */
  | 'not-owed'
  /** Stale, and the ops event was recorded this tick. */
  | 'stale'
  /** Stale, and already reported within FRESHNESS_REPEAT_MS. */
  | 'already-notified'
  /** The evidence query threw; FRESHNESS_CHECK_FAILED_KIND was spooled. */
  | 'check-failed'

type MarkerStore = Pick<LockStore, 'get' | 'put'>

const age = (iso: string, now: Date) => now.getTime() - Date.parse(iso)

/** The verdict for one check's evidence, before any marker is consulted. */
export function freshnessOf(
  evidence: FreshnessEvidence,
  maxAgeMs: number,
  now: Date,
): 'fresh' | 'not-owed' | 'stale' {
  if (evidence.lastOkAt && age(evidence.lastOkAt, now) <= maxAgeMs) return 'fresh'
  if (!evidence.owedSince || age(evidence.owedSince, now) <= maxAgeMs) return 'not-owed'
  return 'stale'
}

/** `3h` or `40min`. */
export function formatDuration(ms: number): string {
  return ms >= HOUR_MS ? `${Math.round(ms / HOUR_MS)}h` : `${Math.round(ms / MINUTE_MS)}min`
}

/** `for 27h (since 2026-11-04T00:18:27Z)`, or `ever` when there has never been a success. */
export function silentFor(lastOk: string | null, now: Date): string {
  if (!lastOk) return 'ever'
  return `for ${Math.floor(age(lastOk, now) / HOUR_MS)}h (since ${lastOk})`
}

/** The ops event's one line. */
export function staleDetail(check: FreshnessCheck, evidence: FreshnessEvidence, now: Date): string {
  const success =
    evidence.lastOkAt === undefined
      ? 'nothing records a success'
      : `no success ${silentFor(evidence.lastOkAt, now)}`
  const note = evidence.note ? `; ${evidence.note}` : ''
  return `${check.label}: work owed since ${evidence.owedSince}, ${success} (limit ${formatDuration(check.maxAgeMs)})${note}`
}

/** Run every check; spool an event for each stale one not reported within FRESHNESS_REPEAT_MS. */
export async function checkFreshness(
  db: PipelineDb,
  marker: MarkerStore,
  checks: readonly FreshnessCheck[],
  now: Date = new Date(),
): Promise<Record<string, FreshnessVerdict>> {
  const verdicts: Record<string, FreshnessVerdict> = {}
  for (const check of checks) {
    let evidence: FreshnessEvidence
    try {
      evidence = await check.evidence(db, now, marker)
    } catch (error) {
      verdicts[check.key] = 'check-failed'
      await recordOpsEvent(db, {
        kind: FRESHNESS_CHECK_FAILED_KIND,
        detail: `${check.label}: ${String(error)}`,
      })
      continue
    }
    const verdict = freshnessOf(evidence, check.maxAgeMs, now)
    if (verdict !== 'stale') {
      verdicts[check.key] = verdict
      continue
    }
    const key = freshnessMarkerKey(check.key)
    if ((await marker.get(key)) !== null) {
      verdicts[check.key] = 'already-notified'
      continue
    }
    await recordOpsEvent(db, {
      kind: check.kind,
      detail: staleDetail(check, evidence, now),
      path: check.path,
    })
    await marker.put(key, now.toISOString(), FRESHNESS_REPEAT_MS / 1000)
    logEvent('warn', check.kind, { check: check.key })
    verdicts[check.key] = 'stale'
  }
  return verdicts
}

// ── scheduled tasks ─────────────────────────────────────────────────────────

/**
 * The interval between fires of a 5-field cron expression, for the shapes this
 * app schedules: every N minutes, every N hours, hourly, daily, weekly. Anything
 * else throws, and freshness.test.ts runs every expression in the cron map, so
 * a new shape fails the build rather than getting a guessed limit.
 */
export function cronIntervalMs(expression: string): number {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`cron "${expression}" does not have 5 fields`)
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]
  const fixed = (f: string) => /^\d+$/.test(f)
  const every = (f: string) => /^\*\/(\d+)$/.exec(f)?.[1]
  // Names only: Cloudflare numbers weekdays from 1 = Sunday, so a numeric day
  // reads as one day and fires on another. Refusing it here fails the build.
  const weekday = (f: string) => /^(sun|mon|tue|wed|thu|fri|sat)$/i.test(f)
  if (dayOfMonth !== '*' || month !== '*') {
    throw new Error(`cron "${expression}": day-of-month and month must be *`)
  }
  const minuteStep = every(minute)
  if (minuteStep && hour === '*' && dayOfWeek === '*') return Number(minuteStep) * MINUTE_MS
  if (fixed(minute)) {
    const hourStep = every(hour)
    if (hour === '*' && dayOfWeek === '*') return HOUR_MS
    if (hourStep && dayOfWeek === '*') return Number(hourStep) * HOUR_MS
    if (fixed(hour) && dayOfWeek === '*') return 24 * HOUR_MS
    if (fixed(hour) && weekday(dayOfWeek)) return 7 * 24 * HOUR_MS
  }
  throw new Error(`cron "${expression}" is not a shape cronIntervalMs reads`)
}

/** One missed run plus half an interval, and never under 30 minutes. */
export function taskMaxAgeMs(expression: string): number {
  const interval = cronIntervalMs(expression)
  return interval + Math.max(30 * MINUTE_MS, interval / 2)
}

type HeartbeatRow = typeof tables.taskHeartbeats.$inferSelect
type HeartbeatReader = (db: PipelineDb) => Promise<HeartbeatRow[]>

const readHeartbeats: HeartbeatReader = (db) => db.select().from(tables.taskHeartbeats)

/**
 * The task_heartbeats table (one row per task), read once however many task
 * checks ask. Make one per tick: it never reads again.
 */
export function heartbeatLoader(): HeartbeatReader {
  let rows: Promise<HeartbeatRow[]> | null = null
  return (db) => (rows ??= readHeartbeats(db))
}

export const expectedMarkerKey = (task: string) => `freshness:expected:${task}`

/** Long enough to outlive any limit; a task that runs once never reads it again. */
const EXPECTED_MARKER_TTL_SECONDS = 90 * 24 * 60 * 60

/**
 * When the checker first saw a task with no heartbeat row. A task added by a
 * deploy is owed from about then, not from when monitoring started: counting
 * from monitoring start flagged events:sweep as silent eleven minutes before
 * its first scheduled run (2026-11-07).
 */
async function firstExpected(marker: MarkerStore, task: string, now: Date): Promise<string> {
  const key = expectedMarkerKey(task)
  const seen = await marker.get(key)
  if (seen) return seen
  await marker.put(key, now.toISOString(), EXPECTED_MARKER_TTL_SECONDS)
  return now.toISOString()
}

/** The check a scheduled task gets from its heartbeat; freshnessChecks() shares one loader across them. */
export function taskHeartbeatCheck(
  task: string,
  expression: string,
  heartbeats: HeartbeatReader = readHeartbeats,
): FreshnessCheck {
  return {
    key: `task:${task}`,
    label: `Scheduled task ${task} (${expression})`,
    kind: TASK_SILENT_KIND,
    maxAgeMs: taskMaxAgeMs(expression),
    async evidence(db, now, marker) {
      const rows = await heartbeats(db)
      const row = rows.find((r) => r.task === task)
      // Monitoring started with the first heartbeat any task wrote.
      const monitoringStart = rows.map((r) => r.first_seen_at).sort()[0] ?? null
      const lastOk = row?.last_completed_at ?? null
      const failedSince =
        row?.last_failed_at && (!lastOk || row.last_failed_at > lastOk) ? row.last_failed_at : null
      return {
        owedSince: row ? monitoringStart : await firstExpected(marker, task, now),
        lastOkAt: lastOk,
        note: !row
          ? 'it has never recorded a run'
          : failedSince
            ? `it threw at ${failedSince}: ${row.last_error}`
            : null,
      }
    },
  }
}
