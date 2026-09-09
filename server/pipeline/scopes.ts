import type { PollScope } from './contracts'
import type { FetchSource } from './sources'

// Which sources each cron tick polls. One file, so the two tasks under
// server/tasks/poll/ share a policy instead of two lists that drift.
//
//   edgar   */30 * * * *   the two SEC feeds — the tripwire, the one axis where
//                          latency is worth polling for.
//   survey  0 */6 * * *    every include source. It re-checks EDGAR on purpose:
//                          an unchanged re-fetch diffs to zero, and the overlap
//                          means a stalled edgar tick goes covered, not blind.
//
// Because 6h is a multiple of 30m the two are due at the same instant every
// sixth hour. The survey is a superset, so at that instant edgar yields
// (server/pipeline/poll.ts) rather than racing it for the lock.

const EDGAR_SOURCES: readonly string[] = ['edgar-fts', 'edgar-submissions-spcx']

export function sourceIdsForScope(scope: PollScope, all: readonly FetchSource[]): string[] {
  const ids = all.map((s) => s.source_id)
  if (scope === 'survey') return ids
  const missing = EDGAR_SOURCES.filter((id) => !ids.includes(id))
  if (missing.length) {
    throw new Error(`edgar scope names sources not in sources.yaml: ${missing.join(', ')}`)
  }
  return [...EDGAR_SOURCES]
}

const EDGAR_PERIOD_MS = 30 * 60 * 1000
const SURVEY_PERIOD_MS = 6 * 60 * 60 * 1000

/**
 * True when `now` is one of the survey's six-hourly instants (00:00, 06:00,
 * 12:00, 18:00 UTC). The cron fires on the minute and the task starts a few
 * seconds later, so the time is rounded to the nearest edgar tick (30 min)
 * before the check, never compared for equality. Pure; mirrors the two
 * expressions in SCHEDULED_TASKS (nuxt.config.ts).
 */
export function isSurveyInstant(now: Date): boolean {
  const msIntoDay =
    now.getUTCHours() * 3_600_000 +
    now.getUTCMinutes() * 60_000 +
    now.getUTCSeconds() * 1000 +
    now.getUTCMilliseconds()
  const nearestEdgarTick = Math.round(msIntoDay / EDGAR_PERIOD_MS) * EDGAR_PERIOD_MS
  return nearestEdgarTick % SURVEY_PERIOD_MS === 0
}
