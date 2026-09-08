import { desc, gt, isNotNull, max } from 'drizzle-orm'

import * as tables from '../../db/schema'
import { ChangeRow } from '../contracts'
import type { PipelineDb } from '../store'

// What GET /api/judge/pending hands the routine: change rows detected since
// the last judged run, minus the ones that only say "the board re-stamped
// its timestamps", newest first and capped.

/**
 * Newest-first cap on what one judge run considers. Changes the model stays
 * SILENT about are never cited, so without a cursor every run would re-send
 * the whole history; with the cursor a cap still matters for the first run
 * over a backlog, where a bounded prompt beats an exhaustive one. The route
 * reports total_pending so a bite of the cap is never silent.
 */
export const JUDGE_CHANGE_LIMIT = 200

/**
 * Normalized-payload fields a job board rewrites without changing the
 * posting. The names are the parser output's (server/pipeline/parsers/hiring):
 * Ashby's `publishedAt` lands as `published_at`, and Greenhouse's
 * `first_published` / `updated_at` as `published_at` / `updated_at`.
 * Model and filing rows carry no such field, so the filter is job-only.
 */
export const JOB_TIMESTAMP_FIELDS = ['published_at', 'updated_at'] as const

/** A job `modified` whose before/after differ only in JOB_TIMESTAMP_FIELDS.
 * Typed on plain strings so a raw D1 row qualifies without a parse. */
export function isTimestampOnlyChange(change: {
  entity_type: string
  change_type: string
  before_json: string | null
  after_json: string | null
}): boolean {
  if (change.entity_type !== 'job' || change.change_type !== 'modified') return false
  if (change.before_json === null || change.after_json === null) return false
  const strip = (json: string) => {
    const value = JSON.parse(json) as Record<string, unknown>
    for (const field of JOB_TIMESTAMP_FIELDS) delete value[field]
    return value
  }
  return stableEquals(strip(change.before_json), strip(change.after_json))
}

function stableEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ak = Object.keys(a).sort()
  const bk = Object.keys(b).sort()
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false
  return ak.every((k) =>
    stableEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

/** The newest judged_through across judge_runs, or null before the first run. */
export async function judgedThrough(db: PipelineDb): Promise<string | null> {
  const [row] = await db
    .select({ at: max(tables.judgeRuns.judged_through) })
    .from(tables.judgeRuns)
    .where(isNotNull(tables.judgeRuns.judged_through))
  return row?.at ?? null
}

export interface PendingChanges {
  changes: ChangeRow[]
  /** Pending after the timestamp filter, before the cap. */
  total_pending: number
  /** The cursor the selection started from; null on the first run. */
  since: string | null
}

export async function pendingChanges(
  db: PipelineDb,
  limit: number = JUDGE_CHANGE_LIMIT,
): Promise<PendingChanges> {
  const since = await judgedThrough(db)
  const rows = await db
    .select()
    .from(tables.changes)
    .where(since ? gt(tables.changes.detected_at, since) : undefined)
    .orderBy(desc(tables.changes.detected_at), desc(tables.changes.id))
  const pending = rows.filter((row) => !isTimestampOnlyChange(row))
  return {
    changes: pending.slice(0, limit).map((row) => ChangeRow.parse(row)),
    total_pending: pending.length,
    since,
  }
}
