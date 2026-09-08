import type { PollScope } from './contracts'
import { withPollLock, type LockOutcome, type LockStore } from './lock'
import { manifestFixtures } from './parsers/fixture-provenance'
import { runRefresh, type RawStore, type RefreshDeps, type RefreshReport } from './refresh'
import { sourceIdsForScope } from './scopes'
import { includeSources } from './sources'

// What a poll task does, minus the bindings: take the lock, resolve the
// scope, run the refresh, say one line about it. Both server/tasks/poll/*
// call this so the tasks are two thin shims over one behaviour.

export interface PollDeps extends Omit<RefreshDeps, 'db'> {
  db: RefreshDeps['db']
  lock: LockStore
}

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

export async function runPoll(
  scope: PollScope,
  deps: PollDeps,
): Promise<LockOutcome<RefreshReport>> {
  const { lock, ...refreshDeps } = deps
  const startedAt = (deps.now ?? (() => new Date()))().toISOString()

  const outcome = await withPollLock(lock, `${scope}@${startedAt}`, () =>
    runRefresh(
      refreshDeps,
      scope,
      sourceIdsForScope(scope, includeSources(deps.sourcesYaml, manifestFixtures)),
    ),
  )

  // One line per tick, always — a quiet poll is still evidence the cron fired.
  if (outcome.skipped) {
    console.warn(JSON.stringify({ kind: 'poll_skipped', scope, heldBy: outcome.heldBy }))
  } else {
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
  }
  return outcome
}
