import { and, asc, gt, lt, max } from 'drizzle-orm'

import * as tables from '../../db/schema'
import { recordOpsEvent } from '../../utils/ops'
import type { LockStore } from '../lock'
import type { PipelineDb } from '../store'
import { isTimestampOnlyChange, judgeEligible, judgedThrough } from './pending'
import { JUDGE_OPS_PATH } from './submit'

// Silence watchdog. The routine runs on the owner's claude.ai account, so
// the Worker cannot see whether it is enabled, out of budget, or failing
// before it reaches the API — the only evidence is the absence of
// judge_runs rows. A day of pending changes with no run is worth one line
// in the ops digest; one line, because the digest cron ticks every 30
// minutes and the marker in KV keeps the event from repeating every tick.

const DAY_MS = 24 * 60 * 60 * 1000
export const JUDGE_SILENCE_MS = DAY_MS
export const JUDGE_SILENT_MARKER_KEY = 'judge:silent-notified'
export const JUDGE_SILENT_MARKER_TTL_SECONDS = DAY_MS / 1000

export type JudgeSilenceVerdict =
  /** A judge run landed within the window. */
  | 'recent-run'
  /** Nothing older than the window is waiting. */
  | 'no-backlog'
  /** Silent, and the ops event was recorded this tick. */
  | 'silent'
  /** Silent, and already reported within the last day. */
  | 'already-notified'

export async function checkJudgeSilence(
  db: PipelineDb,
  marker: LockStore,
  now: Date = new Date(),
): Promise<JudgeSilenceVerdict> {
  const cutoff = new Date(now.getTime() - JUDGE_SILENCE_MS).toISOString()

  const [run] = await db.select({ at: max(tables.judgeRuns.started_at) }).from(tables.judgeRuns)
  if (run?.at && run.at > cutoff) return 'recent-run'

  // Oldest first, bounded: the question is "is anything old still waiting",
  // and the first non-timestamp-only row answers it. The bound only matters
  // when a backlog is made entirely of re-stamped job rows, which the
  // pending route would not offer either — so a miss there is a quiet day,
  // not a lie.
  const since = await judgedThrough(db)
  const oldest = await db
    .select({
      entity_type: tables.changes.entity_type,
      change_type: tables.changes.change_type,
      before_json: tables.changes.before_json,
      after_json: tables.changes.after_json,
    })
    .from(tables.changes)
    .where(
      and(
        judgeEligible(), // a backlog of ranking rows is not a backlog the judge owes
        lt(tables.changes.detected_at, cutoff),
        since ? gt(tables.changes.detected_at, since) : undefined,
      ),
    )
    .orderBy(asc(tables.changes.detected_at))
    .limit(200)
  if (!oldest.some((row) => !isTimestampOnlyChange(row))) return 'no-backlog'

  if ((await marker.get(JUDGE_SILENT_MARKER_KEY)) !== null) return 'already-notified'
  await recordOpsEvent(db, {
    kind: 'judge_silent',
    detail: `changes older than 24h are waiting and no judge run landed since ${run?.at ?? 'ever'}`,
    path: JUDGE_OPS_PATH,
  })
  await marker.put(JUDGE_SILENT_MARKER_KEY, now.toISOString(), JUDGE_SILENT_MARKER_TTL_SECONDS)
  return 'silent'
}
