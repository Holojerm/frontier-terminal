// The heartbeat every scheduled task records (task_heartbeats, schema.ts).
//
// Usage, in every file under */server/tasks/:
//
//   const task = defineTask({ meta: { name: 'poll:survey', … }, async run() { … } })
//
//   export default withHeartbeat(task)
//
// withHeartbeat() runs the task unchanged and, when it ends, upserts one row:
// last_completed_at when run() resolved, last_failed_at and last_error when it
// threw. A throw also spools one TASK_FAILED_KIND ops event and an error log
// line, then the run resolves with no result, so no task needs a whole-run
// try/catch of its own. Neither write fails the task: a D1 hiccup here costs
// one heartbeat, not the task's result.
//
// The freshness checks read these rows (freshness.ts). Coverage is enforced by
// layers/terminal/test/freshness.test.ts: a scheduled task whose file does not
// call withHeartbeat() fails the build unless the registry gives it a check
// of its own, with the reason (TASK_CHECK_OVERRIDES).

import { db } from '@nuxthub/db'
import type { Task, TaskEvent, TaskResult } from 'nitropack/types'

import * as tables from '#server/db/schema'
import { logEvent } from '#server/utils/log'
import { recordOpsEvent } from '#server/utils/ops'
import type { PipelineDb } from '../pipeline/store'

/** Spooled once per run that throws; the detail names the task. */
export const TASK_FAILED_KIND = 'task_failed'

export interface HeartbeatOutcome {
  task: string
  started_at: string
  finished_at: string
  error: string | null
}

/** Upsert the task's row for one finished run. first_seen_at is set on insert only. */
export async function recordHeartbeat(target: PipelineDb, o: HeartbeatOutcome): Promise<void> {
  const failed = o.error !== null
  await target
    .insert(tables.taskHeartbeats)
    .values({
      task: o.task,
      first_seen_at: o.started_at,
      last_started_at: o.started_at,
      last_completed_at: failed ? null : o.finished_at,
      last_failed_at: failed ? o.finished_at : null,
      last_error: failed ? o.error!.slice(0, 500) : null,
    })
    .onConflictDoUpdate({
      target: tables.taskHeartbeats.task,
      set: failed
        ? {
            last_started_at: o.started_at,
            last_failed_at: o.finished_at,
            last_error: o.error!.slice(0, 500),
          }
        : // last_error stays: it says what the last failure was, and when is last_failed_at.
          { last_started_at: o.started_at, last_completed_at: o.finished_at },
    })
}

/** Wrap a task definition so each run records its heartbeat. */
export function withHeartbeat<R = unknown>(
  def: Task<R>,
  target: () => PipelineDb = () => db,
  now: () => Date = () => new Date(),
): Task<R> {
  const name = def.meta?.name
  // The row is keyed by the name the cron map uses; a task without one has nothing to key on.
  if (!name) throw new Error('withHeartbeat: the task has no meta.name')
  const run = def.run
  return {
    ...def,
    async run(event: TaskEvent): Promise<{ result?: R }> {
      const started_at = now().toISOString()
      let error: string | null = null
      let result: TaskResult<R> = {}
      try {
        result = await (run.call(def, event) as Promise<TaskResult<R>>)
      } catch (err) {
        error = String(err)
        // Logged, not rethrown: Nitro runs a cron's tasks under one Promise.all
        // inside waitUntil, so a rejection settles the invocation and can cut
        // off the sibling tasks still running.
        logEvent('error', TASK_FAILED_KIND, { task: name, error })
      }
      const outcome = { task: name, started_at, finished_at: now().toISOString(), error }
      try {
        if (error !== null) {
          await recordOpsEvent(target(), { kind: TASK_FAILED_KIND, detail: `${name}: ${error}` })
        }
        await recordHeartbeat(target(), outcome)
      } catch (writeError) {
        logEvent('error', 'task_heartbeat_write_failed', {
          task: name,
          error: String(writeError),
        })
      }
      return result
    },
  }
}
