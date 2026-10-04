import { RATE_LIMITED_DETAIL } from './fetch'

// Backing off a source that answers 429. The fetcher no longer retries a 429
// in-tick (fetch.ts); this file decides what the refresh does instead:
//
//   cooldown  after a 429 the source is not fetched again until the cooldown
//             passes (a Retry-After longer than the default extends it). A
//             cooling tick writes no run and no event: nothing was attempted.
//   alert     a 429 run is still recorded as 'failed' (the coverage panel stays
//             honest) but raises `source_failed` only once the 429s have run
//             unbroken for RATE_LIMIT_ALERT_AFTER_MS, then again each further
//             day. One good fetch ends the streak.
//
// Pure: callers pass the run history and the clock.

export const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000
export const RATE_LIMIT_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000
export const RATE_LIMIT_ALERT_AFTER_MS = 6 * 60 * 60 * 1000
export const RATE_LIMIT_REALERT_MS = 24 * 60 * 60 * 1000

/** A run as stored in source_runs; newest first wherever a list is taken. */
export interface RunSummary {
  status: string
  detail: string | null
  started_at: string
}

export const isRateLimitRun = (run: RunSummary): boolean =>
  run.status === 'failed' && (run.detail?.startsWith(RATE_LIMITED_DETAIL) ?? false)

/** When a source that last answered 429 may be fetched again, or null if it is not cooling. */
export function cooldownEndsAt(last: RunSummary | undefined): number | null {
  if (!last || !isRateLimitRun(last)) return null
  const asked = Number(last.detail?.match(/Retry-After (\d+)s/)?.[1] ?? 0) * 1000
  const wait = Math.min(Math.max(asked, RATE_LIMIT_COOLDOWN_MS), RATE_LIMIT_MAX_COOLDOWN_MS)
  return Date.parse(last.started_at) + wait
}

/** The unbroken 429 runs at the head of a newest-first history. */
function streakOf(history: readonly RunSummary[]): RunSummary[] {
  const end = history.findIndex((r) => !isRateLimitRun(r))
  return end === -1 ? [...history] : history.slice(0, end)
}

/**
 * Whether the 429 being recorded now should raise `source_failed`. True on the
 * attempt that carries the streak past 6 hours, and on the first attempt of
 * each further day it lasts; never for a transient 429.
 */
export function rateLimitAlertDue(history: readonly RunSummary[], nowMs: number): boolean {
  const streak = streakOf(history)
  if (streak.length === 0) return false
  const since = Date.parse(streak.at(-1)!.started_at)
  const tier = (at: number) =>
    at - since < RATE_LIMIT_ALERT_AFTER_MS
      ? -1
      : Math.floor((at - since - RATE_LIMIT_ALERT_AFTER_MS) / RATE_LIMIT_REALERT_MS)
  return tier(nowMs) > tier(Date.parse(streak[0]!.started_at))
}

/** Where the current 429 streak began (ISO), for the alert text; null when this is the first. */
export function rateLimitSince(history: readonly RunSummary[]): string | null {
  return streakOf(history).at(-1)?.started_at ?? null
}
