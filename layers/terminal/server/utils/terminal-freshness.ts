// This app's freshness checks (the rule is in freshness.ts). ops:watch builds
// them with freshnessChecks() each tick and runs them with checkFreshness().
//
// Every scheduled task gets its heartbeat check, unless TASK_CHECK_OVERRIDES
// gives it one of its own with the reason. Then one check per producer that
// runs off the Worker, read from the rows that producer writes:
//
//   judge         the judge routine (claude.ai), judge_runs — critical
//   gdelt-search  the GDELT Actions job (.github/workflows/gdelt-search.yml),
//                 gdelt_files
//   social-outbox the social outbox, social_posts — its sender is in the
//                 vendored layer and records no heartbeat
//   listing-status the hand-checked "registered" rows, against a stored 424B4
//   deploy        Workers Builds: main's head on GitHub against this build's
//                 sha (pipeline/deploy-watch.ts)
//
// A new producer gets a check here and its kind a tier in
// terminal-ops-severity.ts; freshness.test.ts fails the build on a kind with
// no tier and on a scheduled task with no heartbeat and no override.

import { and, asc, desc, eq, inArray, lte, max, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'

import { deployDriftCheck } from '../pipeline/deploy-watch'
import { judgeFreshnessCheck } from '../pipeline/judge/watchdog'
import { GKG_READY_MS, stampIso } from '../pipeline/track-record/gkg'
import { oldestUnread } from '../pipeline/track-record/search'
import { heartbeatLoader, taskHeartbeatCheck, type FreshnessCheck } from './freshness'
import { ENTITY_IDENTIFIERS, type EntityIdentifier } from './terminal-identifiers'

const HOUR_MS = 60 * 60 * 1000

/**
 * The GDELT job is scheduled twice an hour and GitHub's scheduler skips
 * triggers: hourly, it fired 2 of 12 on 2026-11-06, healthy runs sat up to
 * 7h37m apart that week (issue #301), and 10h49m apart on 2026-11-09
 * (issue #323), which is why it now has two triggers an hour. The limit
 * stays wide enough to clear the spread that remains.
 */
export const GDELT_SILENCE_MS = 9 * HOUR_MS

export const gdeltFreshnessCheck: FreshnessCheck = {
  key: 'gdelt-search',
  label: 'The GDELT file job (GitHub Actions › GDELT search)',
  kind: 'gdelt_search_silent',
  maxAgeMs: GDELT_SILENCE_MS,
  path: '/api/gdelt/work',
  async evidence(db, now) {
    // The oldest unread file has been owed since it was due.
    const oldest = await oldestUnread(db, now)
    const [ok] = await db.select({ at: max(tables.gdeltFiles.recorded_at) }).from(tables.gdeltFiles)
    return {
      owedSince: oldest
        ? new Date(Date.parse(stampIso(oldest)) + GKG_READY_MS).toISOString()
        : null,
      lastOkAt: ok?.at ?? null,
    }
  },
}

/** A queued post due and still queued this long means nothing is draining the social outbox. */
export const SOCIAL_POST_SILENCE_MS = HOUR_MS

/**
 * The social outbox is drained by EVENTS queue messages and the hourly
 * events:sweep (layers/terminal/server/utils/events.ts), and its sender lives in
 * the vendored social layer, which records no heartbeat. Its own rows are the
 * evidence: a due post still queued past the limit is the stall, whichever
 * path should have sent it.
 */
export const socialOutboxFreshnessCheck: FreshnessCheck = {
  key: 'social-outbox',
  label: 'The social outbox (EVENTS social.drain and events:sweep)',
  kind: 'social_outbox_stalled',
  maxAgeMs: SOCIAL_POST_SILENCE_MS,
  async evidence(db, now) {
    const [oldest] = await db
      .select({ due: tables.socialPosts.notBefore })
      .from(tables.socialPosts)
      .where(and(eq(tables.socialPosts.status, 'queued'), lte(tables.socialPosts.notBefore, now)))
      .orderBy(asc(tables.socialPosts.notBefore))
      .limit(1)
    const [sent] = await db
      .select({ at: tables.socialPosts.sentAt })
      .from(tables.socialPosts)
      .where(eq(tables.socialPosts.status, 'sent'))
      .orderBy(desc(tables.socialPosts.sentAt))
      .limit(1)
    return {
      owedSince: oldest ? oldest.due.toISOString() : null,
      lastOkAt: sent?.at ? sent.at.toISOString() : null,
      note: oldest ? 'a due post is still queued' : null,
    }
  },
}

/** How long a final prospectus may sit beside a row that still says "registered". */
export const LISTING_REVIEW_MS = HOUR_MS

/**
 * ENTITY_IDENTIFIERS and ENTITY_SECURITIES are checked by hand, and
 * "registered" (an S-1 on file, shares not yet trading) stops being true the
 * day the offering prices. The filings lane stores the 424B4 that says so and
 * alerts on it, while the two hand-kept rows would go on saying "not yet
 * trading". That filing is the work owed: it stays owed until the rows are
 * re-checked and no longer say "registered".
 */
export const listingStatusCheckOf = (
  identifiers: readonly Pick<EntityIdentifier, 'entity_id' | 'listing_status'>[],
): FreshnessCheck => ({
  key: 'listing-status',
  label: 'A registered filer’s listing status (terminal-identifiers.ts, terminal-entities.ts)',
  kind: 'listing_status_stale',
  maxAgeMs: LISTING_REVIEW_MS,
  path: '/api/identifiers',
  async evidence(db) {
    const registered = identifiers.filter((e) => e.listing_status === 'registered')
    if (registered.length === 0) return { owedSince: null }
    const fileDate = sql<string | null>`json_extract(${tables.entities.payload}, '$.file_date')`
    const [priced] = await db
      .select({ source_id: tables.entities.source_id, fileDate })
      .from(tables.entities)
      .where(
        and(
          inArray(
            tables.entities.source_id,
            registered.map((e) => `edgar-submissions-${e.entity_id}`),
          ),
          eq(tables.entities.entity_type, 'filing'),
          eq(sql`json_extract(${tables.entities.payload}, '$.form')`, '424B4'),
        ),
      )
      .orderBy(asc(fileDate))
      .limit(1)
    if (!priced?.fileDate || !/^\d{4}-\d{2}-\d{2}$/.test(priced.fileDate)) {
      return { owedSince: null }
    }
    return {
      owedSince: `${priced.fileDate}T00:00:00.000Z`,
      note: `${priced.source_id.replace('edgar-submissions-', '')} filed a 424B4 on ${priced.fileDate} and is still listed as registered`,
    }
  },
})

export const listingStatusCheck = listingStatusCheckOf(ENTITY_IDENTIFIERS)

/**
 * Scheduled tasks whose freshness is checked from their own rows instead of
 * a heartbeat, each with the reason. Empty since social:post left the
 * schedule; kept so a task that cannot carry withHeartbeat() has a place.
 */
export const TASK_CHECK_OVERRIDES: Record<
  string,
  { reason: string; check: (expression: string) => FreshnessCheck }
> = {}

export interface FreshnessDeps {
  /** runtimeConfig.scheduledTasks: cron expression → task names. */
  scheduledTasks: Record<string, string[]>
  /** runtimeConfig.public.buildSha; empty for a local build. */
  buildSha: string
  /** Main's head on GitHub this tick, null when it could not be read. */
  mainHead: string | null
}

/** Every check this app runs, tasks first. */
export function freshnessChecks(deps: FreshnessDeps): FreshnessCheck[] {
  const heartbeats = heartbeatLoader()
  const tasks = Object.entries(deps.scheduledTasks).flatMap(([expression, names]) =>
    names.map((name) =>
      TASK_CHECK_OVERRIDES[name]
        ? TASK_CHECK_OVERRIDES[name].check(expression)
        : taskHeartbeatCheck(name, expression, heartbeats),
    ),
  )
  return [
    ...tasks,
    judgeFreshnessCheck,
    gdeltFreshnessCheck,
    socialOutboxFreshnessCheck,
    listingStatusCheck,
    deployDriftCheck(deps.buildSha, deps.mainHead),
  ]
}
