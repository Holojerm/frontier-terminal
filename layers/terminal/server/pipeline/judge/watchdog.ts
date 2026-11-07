import { and, lt, max, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { FreshnessCheck } from '../../utils/freshness'
import type { PipelineDb } from '../store'
import {
  detectedAfter,
  isTimestampOnlyChange,
  isUntrackedFilingChange,
  judgeEligible,
  judgedThrough,
} from './pending'
import { JUDGE_OPS_PATH } from './submit'

// The judge's freshness check (layers/terminal/server/utils/freshness.ts). The
// routine runs on the owner's claude.ai account, so the Worker cannot see
// whether it is enabled, out of budget, or failing before it reaches the API —
// the only evidence is the absence of judge_runs rows. The routine runs hourly,
// so three hours of owed changes with no run is three missed runs: an outage,
// and a critical line in the ops digest (judge_silent,
// layers/terminal/server/utils/terminal-ops-severity.ts). The run itself reports
// success while blocked (a 403 from its environment's proxy ends the run
// cleanly), so this is the only check that sees it.

const HOUR_MS = 60 * 60 * 1000
export const JUDGE_SILENCE_MS = 3 * HOUR_MS

export const judgeFreshnessCheck: FreshnessCheck = {
  key: 'judge',
  label: 'The judge routine',
  kind: 'judge_silent',
  maxAgeMs: JUDGE_SILENCE_MS,
  path: JUDGE_OPS_PATH,
  async evidence(db, now) {
    const cutoff = new Date(now.getTime() - JUDGE_SILENCE_MS).toISOString()
    const [run] = await db.select({ at: max(tables.judgeRuns.started_at) }).from(tables.judgeRuns)
    return { owedSince: await oldestOwedBefore(db, cutoff), lastOkAt: run?.at ?? null }
  },
}

/**
 * The detected_at of the oldest change older than `cutoff` that the judge
 * owes, or null. Oldest first, bounded: the question is "is anything old still
 * waiting", and the first row the pending route would actually offer answers
 * it. Both of that route's filters are applied here for that reason — a
 * backlog made of rows the judge is never handed is not a backlog the judge
 * owes, and reporting one would be a lie in the direction that wakes somebody.
 */
async function oldestOwedBefore(db: PipelineDb, cutoff: string): Promise<string | null> {
  const since = await judgedThrough(db)
  const oldest = await db
    .select({
      entity_type: tables.changes.entity_type,
      change_type: tables.changes.change_type,
      before_json: tables.changes.before_json,
      after_json: tables.changes.after_json,
      detected_at: tables.changes.detected_at,
    })
    .from(tables.changes)
    .where(
      and(
        judgeEligible(), // a backlog of ranking rows is not a backlog the judge owes
        lt(tables.changes.detected_at, cutoff),
        detectedAfter(since),
      ),
    )
    .orderBy(sql`julianday(${tables.changes.detected_at})`)
    .limit(200)
  const owed = oldest.find((row) => !isTimestampOnlyChange(row) && !isUntrackedFilingChange(row))
  return owed?.detected_at ?? null
}
