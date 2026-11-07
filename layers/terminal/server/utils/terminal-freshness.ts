// This app's freshness checks (the rule is in freshness.ts). ops:alert builds
// them with freshnessChecks() each tick and runs them with checkFreshness().
//
// Every scheduled task gets its heartbeat check, unless TASK_CHECK_OVERRIDES
// gives it one of its own with the reason. Then one check per producer that
// runs off the Worker, read from the rows that producer writes:
//
//   judge         the judge routine (claude.ai), judge_runs — critical
//   gdelt-search  the GDELT Actions job (.github/workflows/gdelt-search.yml),
//                 gdelt_files
//   press-drafts  the press-drafts routine (claude.ai), the KV drafted markers
//   social-outbox the social outbox, social_posts — its sender is in the
//                 vendored layer and records no heartbeat
//   deploy        Workers Builds: main's head on GitHub against this build's
//                 sha (pipeline/deploy-watch.ts)
//
// A new producer gets a check here and its kind a tier in
// terminal-ops-severity.ts; freshness.test.ts fails the build on a kind with
// no tier and on a scheduled task with no heartbeat and no override.

import { and, asc, desc, eq, lte, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'

import { deployDriftCheck } from '../pipeline/deploy-watch'
import { judgeFreshnessCheck } from '../pipeline/judge/watchdog'
import { parsePressList, pendingPressAlerts } from '../pipeline/press'
import { GKG_READY_MS, stampIso } from '../pipeline/track-record/gkg'
import { oldestUnread } from '../pipeline/track-record/search'
import { heartbeatLoader, taskHeartbeatCheck, type FreshnessCheck } from './freshness'

const HOUR_MS = 60 * 60 * 1000

/**
 * The GDELT job runs hourly and GitHub's scheduler skips some hours (on
 * 2026-11-06 it fired 2 of 12), so a few empty hours are normal.
 */
export const GDELT_SILENCE_MS = 6 * HOUR_MS

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

/** The press-drafts routine runs hourly (.claude/routines/press-drafts.md). */
export const PRESS_DRAFTS_SILENCE_MS = 6 * HOUR_MS

/**
 * `drafted` answers whether an alert's drafts were saved (the KV marker the
 * routine sets through POST /api/press/drafted); `pressList` is
 * NUXT_PRESS_LIST. With no press list nothing is owed: the pending route hands
 * out nothing then, so the routine has nothing to do.
 */
export function pressDraftsFreshnessCheck(
  drafted: (id: string) => Promise<boolean>,
  pressList: unknown,
): FreshnessCheck {
  return {
    key: 'press-drafts',
    label: 'The press-drafts routine',
    kind: 'press_drafts_silent',
    maxAgeMs: PRESS_DRAFTS_SILENCE_MS,
    path: '/api/press/pending',
    async evidence(db) {
      if (!parsePressList(pressList).length) return { owedSince: null }
      const pending = await pendingPressAlerts(db, drafted)
      const oldest = pending.map((a) => a.created_at).sort()[0] ?? null
      // The routine leaves no row of its own, only the markers; an alert
      // still pending past the limit is the evidence.
      return { owedSince: oldest, lastOkAt: undefined }
    },
  }
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
  drafted: (id: string) => Promise<boolean>
  pressList: unknown
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
    pressDraftsFreshnessCheck(deps.drafted, deps.pressList),
    deployDriftCheck(deps.buildSha, deps.mainHead),
  ]
}
