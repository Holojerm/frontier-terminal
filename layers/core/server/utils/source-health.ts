import { and, count, desc, eq, gte, gt, min, ne } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { SourceHealth, SourceRunStamp } from '../../shared/utils/terminal-types/coverage'
import type { PipelineDb } from '../pipeline/store'

// Whether a source is degraded, for the coverage panel. The last check's
// badge says how one poll ended, which hides the two ways a source goes bad
// in practice. mistral-status refused every poll from 06:00Z on 2026-11-16
// with a 429 (issue #406): the badge read "failed", the same as a single
// blip. OpenAI's docs pages returned a 403 on about one poll a day (issue
// #402): each recovered by the next poll, so the badge read "unchanged" and
// the panel showed nothing at all.
//
// So two facts per source, read from source_runs: when its current run of
// failed checks began, and how many checks failed in the last week.

/** A run of failed checks this long is "failing": the rate-limit alert's threshold (pipeline/rate-limit.ts). */
export const FAILING_AFTER_MS = 6 * 60 * 60 * 1000

/** The window failed checks are counted over. */
export const HEALTH_WINDOW_DAYS = 7

/** Failed checks in the window that make a passing source "intermittent". */
export const INTERMITTENT_MIN_FAILURES = 3

const DAY_MS = 86_400_000

/** Pure: the verdict for one source at `asOf` (the newest check of any source, never the wall clock). */
export function sourceHealth(
  lastRun: Pick<SourceRunStamp, 'status'> | null,
  failures: number,
  failingSince: string | null,
  asOf: string,
): SourceHealth | null {
  if (
    lastRun?.status === 'failed' &&
    failingSince &&
    Date.parse(asOf) - Date.parse(failingSince) >= FAILING_AFTER_MS
  ) {
    return { kind: 'failing', since: failingSince }
  }
  return failures >= INTERMITTENT_MIN_FAILURES
    ? { kind: 'intermittent', failures, window_days: HEALTH_WINDOW_DAYS }
    : null
}

/** For each source whose last check failed: the first failed check after its last check that did not fail. */
export async function failingStreaks(
  db: PipelineDb,
  failingNow: readonly string[],
): Promise<Map<string, string>> {
  const since = new Map<string, string>()
  for (const sourceId of failingNow) {
    const [good] = await db
      .select({ at: tables.sourceRuns.started_at })
      .from(tables.sourceRuns)
      .where(and(eq(tables.sourceRuns.source_id, sourceId), ne(tables.sourceRuns.status, 'failed')))
      .orderBy(desc(tables.sourceRuns.started_at))
      .limit(1)
    const [first] = await db
      .select({ at: min(tables.sourceRuns.started_at) })
      .from(tables.sourceRuns)
      .where(
        and(
          eq(tables.sourceRuns.status, 'failed'),
          eq(tables.sourceRuns.source_id, sourceId),
          good ? gt(tables.sourceRuns.started_at, good.at) : undefined,
        ),
      )
    if (first?.at) since.set(sourceId, first.at)
  }
  return since
}

/**
 * The sources that are failing at `asOf` (the newest check of any source),
 * with when each one's run of failed checks began. Every payload that cites
 * one says so (markFailing), so a number from a source we can no longer read
 * does not sit under a fresh "as of". source_stats holds each source's newest
 * check, so this reads one source_runs row per source.
 */
export async function failingSources(
  db: PipelineDb,
  asOf: string | null,
): Promise<Record<string, string>> {
  if (!asOf) return {}
  const failed = await db
    .select({ source_id: tables.sourceRuns.source_id })
    .from(tables.sourceStats)
    .innerJoin(
      tables.sourceRuns,
      and(
        eq(tables.sourceRuns.source_id, tables.sourceStats.source_id),
        eq(tables.sourceRuns.started_at, tables.sourceStats.last_run_at),
      ),
    )
    .where(eq(tables.sourceRuns.status, 'failed'))
  const since = await failingStreaks(db, [...new Set(failed.map((r) => r.source_id))])
  const failing: Record<string, string> = {}
  for (const [sourceId, at] of since) {
    if (sourceHealth({ status: 'failed' }, 0, at, asOf)?.kind === 'failing') failing[sourceId] = at
  }
  return failing
}

const isCitation = (v: object): v is { source_id: string; failing_since?: string } =>
  typeof (v as Record<string, unknown>).source_id === 'string' &&
  typeof (v as Record<string, unknown>).source_url === 'string' &&
  typeof (v as Record<string, unknown>).fetched_at === 'string'

/**
 * Stamp `failing_since` on every citation in `payload` (an object with
 * source_id, source_url and fetched_at) whose source is in `failing`. Walks
 * the payload in place and returns it; with nothing failing it does not walk.
 */
export function markFailing<T>(payload: T, failing: Readonly<Record<string, string>>): T {
  if (Object.keys(failing).length === 0) return payload
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v === null || typeof v !== 'object') return
    if (isCitation(v) && failing[v.source_id]) v.failing_since = failing[v.source_id]
    Object.values(v).forEach(walk)
  }
  walk(payload)
  return payload
}

/**
 * Failed checks per source in the window before `asOf`, and, for each source
 * whose last check failed, the first failed check after its last check that
 * did not fail. Every read goes through an index on source_runs: the failed
 * count through (status, source_id, started_at), and the streak walks one
 * source's runs back from the newest, which stops at its last good check.
 */
export async function sourceFailures(
  db: PipelineDb,
  failingNow: readonly string[],
  asOf: string,
): Promise<{ failures: Map<string, number>; since: Map<string, string> }> {
  const windowStart = new Date(Date.parse(asOf) - HEALTH_WINDOW_DAYS * DAY_MS).toISOString()
  const counted = await db
    .select({ source_id: tables.sourceRuns.source_id, n: count() })
    .from(tables.sourceRuns)
    .where(
      and(eq(tables.sourceRuns.status, 'failed'), gte(tables.sourceRuns.started_at, windowStart)),
    )
    .groupBy(tables.sourceRuns.source_id)
  const failures = new Map(counted.map((r) => [r.source_id, r.n]))

  const since = await failingStreaks(db, failingNow)
  return { failures, since }
}
