import { and, asc, gt, lt, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import type { LockStore } from '../lock'
import type { PipelineDb } from '../store'
import {
  isTimestampOnlyChange,
  isUntrackedFilingChange,
  judgeEligible,
  judgedThrough,
} from './pending'
import { JUDGE_OPS_PATH } from './submit'

// Silence watchdog. The routine runs on the owner's claude.ai account, so
// the Worker cannot see whether it is enabled, out of budget, or failing
// before it reaches the API — the only evidence is the absence of
// judge_runs rows. The routine runs hourly, so three hours of owed changes
// with no run is three missed runs: an outage, and a critical line in the ops
// digest (layers/terminal/server/utils/ops-severity.ts). The marker in KV
// repeats it every six hours while it lasts rather than every 30-minute tick.
// The run itself reports success while blocked (a 403 from its environment's
// proxy ends the run cleanly), so this is the only check that sees it.

const HOUR_MS = 60 * 60 * 1000
export const JUDGE_SILENCE_MS = 3 * HOUR_MS
export const JUDGE_SILENT_MARKER_KEY = 'judge:silent-notified'
export const JUDGE_SILENT_MARKER_TTL_SECONDS = (6 * HOUR_MS) / 1000

export type JudgeSilenceVerdict =
  /** A judge run landed within the window. */
  | 'recent-run'
  /** Nothing older than the window is waiting. */
  | 'no-backlog'
  /** Silent, and the ops event was recorded this tick. */
  | 'silent'
  /** Silent, and already reported within the marker's TTL. */
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
  // and the first row the pending route would actually offer answers it. Both
  // of that route's filters are applied here for that reason — a backlog made
  // of rows the judge is never handed is not a backlog the judge owes, and
  // reporting one would be a lie in the direction that wakes somebody.
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
  const owed = oldest.some((row) => !isTimestampOnlyChange(row) && !isUntrackedFilingChange(row))
  if (!owed) return 'no-backlog'

  if ((await marker.get(JUDGE_SILENT_MARKER_KEY)) !== null) return 'already-notified'
  await recordOpsEvent(db, {
    kind: 'judge_silent',
    detail: `changes older than ${JUDGE_SILENCE_MS / HOUR_MS}h are waiting and no judge run landed ${silentFor(run?.at, now)}`,
    path: JUDGE_OPS_PATH,
  })
  await marker.put(JUDGE_SILENT_MARKER_KEY, now.toISOString(), JUDGE_SILENT_MARKER_TTL_SECONDS)
  return 'silent'
}

/** `for 27h (since 2026-11-04T00:18:27Z)`, or `ever` when there has never been a run. */
function silentFor(lastRun: string | null | undefined, now: Date): string {
  if (!lastRun) return 'ever'
  const hours = Math.floor((now.getTime() - Date.parse(lastRun)) / HOUR_MS)
  return `for ${hours}h (since ${lastRun})`
}
