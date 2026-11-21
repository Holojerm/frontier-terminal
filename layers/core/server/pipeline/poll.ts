import { recordOpsEvent } from '#server/utils/ops'
import { deriveSources } from '#server/registries/derived'
import type { PollScope } from '../utils/contracts'
import { withPollLock, type LockRetry, type LockStore } from '../utils/pipeline-lock'
import { manifestFixtures } from '../utils/fixture-provenance'
import { runRefresh, type RefreshDeps, type RefreshReport } from './refresh'
import { isSurveyInstant, isUntilParsedSource, sourceIdsForScope } from './scopes'
import { includeSources } from '../utils/pipeline-sources'
import { sourcesWithGoodRun } from '../utils/pipeline-store'

// What a poll task does, minus the bindings: claim the tick, take the lock,
// resolve the scope, run the refresh, log one line. At the shared six-hourly
// instant edgar yields without touching the lock, since the survey re-fetches
// its sources (scopes.ts); letting whichever won the lock run left pricing and
// hiring twelve hours stale.

export interface PollDeps extends Omit<RefreshDeps, 'db'> {
  db: RefreshDeps['db']
  lock: LockStore
  /** Overrides SURVEY_LOCK_RETRY, for tests only. */
  surveyLockRetry?: LockRetry
}

/**
 * How long the survey keeps trying for the lock: 5 × 15 s, well inside one
 * cron invocation. Covers KV's eventual consistency and a stale key from a
 * crashed tick (at most the 10-min TTL). Edgar never retries: at the shared
 * instant it has already yielded, and otherwise its next tick is thirty
 * minutes away. The six-hourly careers and filings lanes retry the same way.
 */
const SURVEY_LOCK_RETRY: LockRetry = { retries: 5, delayMs: 15_000 }

/** The six-hourly scopes: a lost tick is six hours stale, so they retry the lock and report a skip. */
const SIX_HOURLY: ReadonlySet<PollScope> = new Set(['survey', 'careers', 'filings'])

export type PollOutcome =
  | { status: 'ran'; result: RefreshReport }
  | { status: 'skipped'; heldBy: string }
  | { status: 'yielded'; to: 'survey' }

export async function runPoll(scope: PollScope, deps: PollDeps): Promise<PollOutcome> {
  const { lock, surveyLockRetry, ...refreshDeps } = deps
  const now = (deps.now ?? (() => new Date()))()

  // One line per tick, always: a quiet poll is still evidence the cron fired.
  if (scope === 'edgar' && isSurveyInstant(now)) {
    console.warn(JSON.stringify({ kind: 'poll_yielded', scope, to: 'survey' }))
    return { status: 'yielded', to: 'survey' }
  }

  const retry: LockRetry = SIX_HOURLY.has(scope)
    ? (surveyLockRetry ?? SURVEY_LOCK_RETRY)
    : { retries: 0, delayMs: 0 }
  const sources = [
    ...includeSources(deps.sourcesYaml, manifestFixtures),
    ...(await deriveSources(deps.db, deps.sourcesYaml)),
  ]
  const outcome = await withPollLock(
    lock,
    `${scope}@${now.toISOString()}`,
    async () =>
      runRefresh(
        refreshDeps,
        scope,
        sourceIdsForScope(
          scope,
          sources,
          now,
          await sourcesWithGoodRun(
            deps.db,
            sources.map((s) => s.source_id).filter(isUntilParsedSource),
          ),
        ),
      ),
    retry,
  )

  if (outcome.skipped) {
    console.warn(JSON.stringify({ kind: 'poll_skipped', scope, heldBy: outcome.heldBy }))
    // A skipped survey is six hours of stale pricing and hiring, so the owner
    // hears about it. A skipped edgar tick is covered thirty minutes later.
    if (SIX_HOURLY.has(scope)) {
      await recordOpsEvent(deps.db, {
        kind: 'poll_skipped',
        detail: `${scope}: lock held by ${outcome.heldBy} after ${retry.retries} retries`,
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
