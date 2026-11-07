// Mails a critical ops event when it is spooled instead of at the next
// half-hourly digest (server/tasks/ops/alert.ts). Wired from
// layers/terminal/server/plugins/ops-immediate.ts through core's
// onOpsEventRecorded().
//
// Two things count as critical here, the same two the digest leads with:
//   - a kind registered as critical (all_sources_failed, judge_silent);
//   - a server_error burst: SERVER_ERROR_CRITICAL_COUNT unmailed 5xx rows.
// What goes out is the ordinary digest of everything pending, so the email
// looks like any other and the cron finds those rows already marked.
//
// A failing site records a 5xx per request, so two throttles keep this from
// becoming a mail storm or a D1 load of its own: the burst count is read at
// most once a minute per isolate, and one immediate digest per
// OPS_IMMEDIATE_INTERVAL_SECONDS across isolates (a KV claim). Anything held
// back by the claim goes out with the next digest.

import { and, count, eq, isNull } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { CacheStore } from './terminal-cache'
import {
  drainOpsEvents,
  type OpsDb,
  type OpsDigestOptions,
  type OpsEventInput,
  type OpsMailer,
} from '#server/utils/ops'
import type { OpsClassifier } from '#server/utils/ops-digest'
import { SERVER_ERROR_CRITICAL_COUNT } from '#server/utils/ops-severity'

/** At most one immediate digest per this many seconds, account-wide. KV's TTL floor is 60. */
export const OPS_IMMEDIATE_INTERVAL_SECONDS = 300

/** How often one isolate may count unmailed 5xx rows. */
export const BURST_CHECK_INTERVAL_MS = 60_000

export const OPS_IMMEDIATE_CLAIM_KEY = 'ops:immediate-sent'

export interface ImmediateDeps {
  classify: OpsClassifier
  /** Null when alerting is unconfigured, or when no Worker env is reachable. */
  mailer: OpsMailer | null
  store: CacheStore
  options: OpsDigestOptions
  now?: () => number
}

export type ImmediateOutcome =
  | 'not-critical'
  | 'unconfigured'
  | 'throttled'
  | 'sent'
  | 'send-failed'

let lastBurstCheck = Number.NEGATIVE_INFINITY

/** Test-only. */
export function resetOpsImmediateForTest(): void {
  lastBurstCheck = Number.NEGATIVE_INFINITY
}

export async function notifyIfCritical(
  db: OpsDb,
  input: OpsEventInput,
  deps: ImmediateDeps,
): Promise<ImmediateOutcome> {
  const now = deps.now ?? Date.now
  if (!(await isCritical(db, input.kind, deps.classify, now()))) return 'not-critical'
  if (!deps.mailer) return 'unconfigured'
  if (await deps.store.get(OPS_IMMEDIATE_CLAIM_KEY)) return 'throttled'
  await deps.store.set(OPS_IMMEDIATE_CLAIM_KEY, true, { ttl: OPS_IMMEDIATE_INTERVAL_SECONDS })

  const result = await drainOpsEvents(db, deps.mailer, {
    ...deps.options,
    classify: deps.classify,
    now: new Date(now()),
  })
  return result.sent ? 'sent' : 'send-failed'
}

async function isCritical(
  db: OpsDb,
  kind: string,
  classify: OpsClassifier,
  now: number,
): Promise<boolean> {
  if (kind !== 'server_error') return classify(kind, 1).severity === 'critical'
  if (now - lastBurstCheck < BURST_CHECK_INTERVAL_MS) return false
  lastBurstCheck = now
  const [row] = await db
    .select({ n: count() })
    .from(tables.opsEvents)
    .where(and(isNull(tables.opsEvents.notifiedAt), eq(tables.opsEvents.kind, 'server_error')))
  return (row?.n ?? 0) >= SERVER_ERROR_CRITICAL_COUNT
}
