// This app's freshness checks (the rule is in freshness.ts). ops:alert builds
// them with freshnessChecks() each tick and runs them with checkFreshness().
//
// Every scheduled task gets its heartbeat check, unless TASK_CHECK_OVERRIDES
// gives it one of its own with the reason. Then one check per producer that
// runs off the Worker, read from the rows that producer writes:
//
//   judge         the judge routine (claude.ai), judge_runs — critical
//   gdelt-search  the GDELT Actions job (.github/workflows/gdelt-search.yml),
//                 track_record_searches
//   press-drafts  the press-drafts routine (claude.ai), the KV drafted markers
//
// A new producer gets a check here and its kind a tier in
// terminal-ops-severity.ts; freshness.test.ts fails the build on a kind with
// no tier and on a scheduled task with no heartbeat and no override.

import { and, asc, desc, eq, lte, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'

import { judgeFreshnessCheck } from '../pipeline/judge/watchdog'
import { parsePressList, pendingPressAlerts } from '../pipeline/press'
import { dueGdeltSearches } from '../pipeline/track-record/search'
import { taskHeartbeatCheck, type FreshnessCheck } from './freshness'

const HOUR_MS = 60 * 60 * 1000

/** The GDELT job runs hourly and stops at GDELT's first 429, so a few empty hours are normal. */
export const GDELT_SILENCE_MS = 6 * HOUR_MS

export const gdeltFreshnessCheck: FreshnessCheck = {
  key: 'gdelt-search',
  label: 'The GDELT search job (GitHub Actions › GDELT search)',
  kind: 'gdelt_search_silent',
  maxAgeMs: GDELT_SILENCE_MS,
  path: '/api/gdelt/pending',
  async evidence(db, now) {
    // The oldest due search has been owed since its window closed.
    const [due] = await dueGdeltSearches(db, now, 1)
    const [ok] = await db
      .select({ at: max(tables.trackRecordSearches.searched_at) })
      .from(tables.trackRecordSearches)
      .where(
        and(
          eq(tables.trackRecordSearches.source, 'gdelt'),
          eq(tables.trackRecordSearches.status, 'ok'),
        ),
      )
    return { owedSince: due?.window_end ?? null, lastOkAt: ok?.at ?? null }
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

/** A queued post that is due and still queued this long means social:post is not sending. */
export const SOCIAL_POST_SILENCE_MS = HOUR_MS

/**
 * Scheduled tasks whose freshness is checked from their own rows instead of
 * a heartbeat, each with the reason.
 */
export const TASK_CHECK_OVERRIDES: Record<
  string,
  { reason: string; check: (expression: string) => FreshnessCheck }
> = {
  'social:post': {
    reason:
      'The task is in the vendored social layer, whose files layers:check pins to the lock, so it cannot carry withHeartbeat(). Its own queue is better evidence anyway: a due post still queued is the stall.',
    check: (expression) => ({
      key: 'task:social:post',
      label: `Scheduled task social:post (${expression})`,
      kind: 'task_silent',
      maxAgeMs: SOCIAL_POST_SILENCE_MS,
      async evidence(db, now) {
        const [oldest] = await db
          .select({ due: tables.socialPosts.notBefore })
          .from(tables.socialPosts)
          .where(
            and(eq(tables.socialPosts.status, 'queued'), lte(tables.socialPosts.notBefore, now)),
          )
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
    }),
  },
}

export interface FreshnessDeps {
  /** runtimeConfig.scheduledTasks: cron expression → task names. */
  scheduledTasks: Record<string, string[]>
  drafted: (id: string) => Promise<boolean>
  pressList: unknown
}

/** Every check this app runs, tasks first. */
export function freshnessChecks(deps: FreshnessDeps): FreshnessCheck[] {
  const tasks = Object.entries(deps.scheduledTasks).flatMap(([expression, names]) =>
    names.map((name) =>
      TASK_CHECK_OVERRIDES[name]
        ? TASK_CHECK_OVERRIDES[name].check(expression)
        : taskHeartbeatCheck(name, expression),
    ),
  )
  return [
    ...tasks,
    judgeFreshnessCheck,
    gdeltFreshnessCheck,
    pressDraftsFreshnessCheck(deps.drafted, deps.pressList),
  ]
}
