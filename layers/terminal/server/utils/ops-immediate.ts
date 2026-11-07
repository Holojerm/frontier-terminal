// Mails a critical ops event when it is spooled instead of at the next
// ops:alert tick (server/tasks/ops/alert.ts). Wired from
// layers/terminal/server/plugins/ops-immediate.ts through core's
// onOpsEventRecorded().
//
// Two things count as critical here, the same two the tick mails:
//   - a kind registered as critical (all_sources_failed, judge_silent,
//     workers_issue);
//   - a server_error burst: SERVER_ERROR_CRITICAL_COUNT unmailed 5xx rows.
// The send is sendCriticalAlerts() (ops-alerts.ts): one email per critical
// kind per CRITICAL_COOLDOWN_MS, across isolates, carrying only critical rows.
// Warnings wait for the daily digest.
//
// A failing site records a 5xx per request, so the burst count is read at
// most once a minute per isolate.

import { and, count, eq, isNull } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { OpsDb, OpsEventInput } from '#server/utils/ops'
import type { OpsClassifier } from '#server/utils/ops-digest'
import { SERVER_ERROR_CRITICAL_COUNT } from '#server/utils/ops-severity'

import { sendCriticalAlerts, type OpsAlertDeps } from './ops-alerts'

/** How often one isolate may count unmailed 5xx rows. */
export const BURST_CHECK_INTERVAL_MS = 60_000

export interface ImmediateDeps extends Omit<OpsAlertDeps, 'mailer' | 'now'> {
  /** Null when alerting is unconfigured, or when no Worker env is reachable. */
  mailer: OpsAlertDeps['mailer'] | null
  now?: () => number
}

export type ImmediateOutcome = 'not-critical' | 'unconfigured' | 'repeat' | 'sent' | 'send-failed'

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

  const result = await sendCriticalAlerts(db, {
    ...deps,
    mailer: deps.mailer,
    now: new Date(now()),
  })
  if (result.error) return 'send-failed'
  return result.sent.includes(input.kind) ? 'sent' : 'repeat'
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
