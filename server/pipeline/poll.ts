import { recordOpsEvent } from '../utils/ops'
import type { PollScope } from './contracts'
import { withPollLock, type LockRetry, type LockStore } from './lock'
import { manifestFixtures } from './parsers/fixture-provenance'
import { runRefresh, type RawStore, type RefreshDeps, type RefreshReport } from './refresh'
import { isSurveyInstant, sourceIdsForScope } from './scopes'
import { includeSources } from './sources'

// What a poll task does, minus the bindings: decide whether this tick is
// ours, take the lock, resolve the scope, run the refresh, say one line about
// it. Both server/tasks/poll/* call this so the tasks are two thin shims over
// one behaviour.
//
// At the shared six-hourly instant edgar yields without touching the lock:
// the survey re-fetches EDGAR (scopes.ts), so nothing is lost, and the
// alternative — whichever wins the lock runs — let the survey lose twice in
// a row in production and left pricing and hiring twelve hours stale.

export interface PollDeps extends Omit<RefreshDeps, 'db'> {
  db: RefreshDeps['db']
  lock: LockStore
  /** Overrides SURVEY_LOCK_RETRY. Tests only — production uses the constant. */
  surveyLockRetry?: LockRetry
}

/**
 * How long the survey keeps trying for the lock: 5 × 15 s, well inside one
 * cron invocation. Covers KV's eventual consistency and a stale key from a
 * crashed tick (at most the 10-min TTL, usually far less). Edgar never
 * retries — at the shared instant it has already yielded, and otherwise its
 * next tick is thirty minutes away.
 */
export const SURVEY_LOCK_RETRY: LockRetry = { retries: 5, delayMs: 15_000 }

export type PollOutcome =
  | { status: 'ran'; result: RefreshReport }
  | { status: 'skipped'; heldBy: string }
  | { status: 'yielded'; to: 'survey' }

/** NuxtHub's `blob` (or anything with its put signature) as a RawStore. */
export function blobRawStore(blob: {
  put(pathname: string, body: string, options?: { contentType?: string }): Promise<unknown>
}): RawStore {
  return {
    put: async (key, body, contentType) => {
      await blob.put(key, body, { contentType })
    },
  }
}

export async function runPoll(scope: PollScope, deps: PollDeps): Promise<PollOutcome> {
  const { lock, surveyLockRetry, ...refreshDeps } = deps
  const now = (deps.now ?? (() => new Date()))()

  // One line per tick, always — a quiet poll is still evidence the cron fired.
  if (scope === 'edgar' && isSurveyInstant(now)) {
    console.warn(JSON.stringify({ kind: 'poll_yielded', scope, to: 'survey' }))
    return { status: 'yielded', to: 'survey' }
  }

  const retry: LockRetry =
    scope === 'survey' ? (surveyLockRetry ?? SURVEY_LOCK_RETRY) : { retries: 0, delayMs: 0 }
  const outcome = await withPollLock(
    lock,
    `${scope}@${now.toISOString()}`,
    () =>
      runRefresh(
        refreshDeps,
        scope,
        sourceIdsForScope(scope, includeSources(deps.sourcesYaml, manifestFixtures)),
      ),
    retry,
  )

  if (outcome.skipped) {
    console.warn(JSON.stringify({ kind: 'poll_skipped', scope, heldBy: outcome.heldBy }))
    // A skipped survey is six hours of stale pricing and hiring — the owner
    // hears about it. A skipped edgar tick is covered thirty minutes later.
    if (scope === 'survey') {
      await recordOpsEvent(deps.db, {
        kind: 'poll_skipped',
        detail: `survey: lock held by ${outcome.heldBy} after ${retry.retries} retries`,
      })
    }
    return { status: 'skipped', heldBy: outcome.heldBy }
  }

  const { result } = outcome
  console.warn(
    JSON.stringify({
      kind: 'poll_run',
      scope,
      started_at: result.started_at,
      sources: result.sources.length,
      failed: result.failed,
      statuses: Object.fromEntries(result.sources.map((s) => [s.source_id, s.status])),
    }),
  )
  return { status: 'ran', result }
}
