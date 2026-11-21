import { and, lt, max, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  detectedAfter,
  isTimestampOnlyChange,
  isUntrackedFilingChange,
  judgeEligible,
  judgedThrough,
} from '#layers/core/server/pipeline/judge/pending'
import { JUDGE_OPS_PATH } from './submit'

// The judge's freshness check (layers/core/server/utils/freshness.ts). The
// routine runs on the owner's claude.ai account, out of the Worker's sight,
// and a blocked run (a 403 from its proxy) still reports success, so missing
// judge_runs rows are the only evidence. Three hours of owed changes with no
// run is an outage (judge_silent, layers/core/server/utils/terminal-ops-severity.ts).

const HOUR_MS = 60 * 60 * 1000
const JUDGE_SILENCE_MS = 3 * HOUR_MS

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
 * owes, or null. It applies both of the pending route's filters: a backlog of
 * rows the judge is never handed is not owed, and reporting one would wake
 * somebody for nothing.
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
