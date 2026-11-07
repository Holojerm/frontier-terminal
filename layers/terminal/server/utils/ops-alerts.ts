// The alert mailer: which spooled ops events become email, and when. Replaces
// core's mail-everything-every-30-minutes drain for this app; the rules are in
// ops-throttle.ts, and the state they need between runs in ops_alert_state.
//
// Two entry points:
//   - sendCriticalAlerts — run by every ops:alert tick and by ops-immediate.ts
//     the moment a critical row is spooled. One email per critical kind per
//     cooldown; a repeat inside it is settled without a send.
//   - runDailyDigest — run by the tick; does work once a day.
//
// Rows are settled (notified_at) once a decision is made about them, mailed
// or not, so the spool never re-reads them. They stay in ops_events for the
// retention window, where GET /api/ops/events and the ops-triage routine read
// them. A failed send settles nothing and releases its claim: the next tick
// retries, as core's drain does.

import type { BatchItem } from 'drizzle-orm/batch'
import { and, inArray, isNull, like, or, lte } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { OpsEvent } from '#server/db/schema'
import {
  buildOpsDigest,
  type OpsDb,
  type OpsDigestOptions,
  type OpsMailer,
} from '#server/utils/ops'
import type { OpsClassifier } from '#server/utils/ops-digest'
import { logEvent } from '#server/utils/log'

import {
  CRITICAL_COOLDOWN_MS,
  criticalGroups,
  criticalKey,
  dailyDigestDue,
  planDailyDigest,
  recoveredRow,
  type Streak,
} from './ops-throttle'

/** Most pending rows one run reads. A day's spool is well under a hundred. */
export const OPS_PENDING_READ_LIMIT = 5000

export const DAILY_DIGEST_KEY = 'digest:daily'

export interface OpsAlertDeps {
  mailer: OpsMailer
  classify: OpsClassifier
  options: Omit<OpsDigestOptions, 'classify' | 'now'>
  now?: Date
}

export interface CriticalResult {
  /** Critical kinds mailed this run. */
  sent: string[]
  /** Rows settled without a send because their kind was mailed inside the cooldown. */
  suppressed: number
  error?: string
}

export interface DailyResult {
  due: boolean
  sent?: boolean
  /** Pending rows the run settled. */
  settled?: number
  error?: string
}

export async function pendingOpsEvents(db: OpsDb): Promise<OpsEvent[]> {
  return db
    .select()
    .from(tables.opsEvents)
    .where(isNull(tables.opsEvents.notifiedAt))
    .limit(OPS_PENDING_READ_LIMIT)
}

export async function settleOpsEvents(db: OpsDb, ids: string[], now: Date): Promise<void> {
  // Chunked so a large drain can't build a SQL statement D1 will reject.
  for (let i = 0; i < ids.length; i += 50) {
    await db
      .update(tables.opsEvents)
      .set({ notifiedAt: now })
      .where(
        and(
          isNull(tables.opsEvents.notifiedAt),
          inArray(tables.opsEvents.id, ids.slice(i, i + 50)),
        ),
      )
  }
}

/**
 * Take the right to mail `kind` now. One conditional upsert, so two isolates
 * spooling the same critical kind at once send one email between them.
 */
export async function claimCritical(db: OpsDb, kind: string, now: Date): Promise<boolean> {
  const nowIso = now.toISOString()
  const cutoff = new Date(now.getTime() - CRITICAL_COOLDOWN_MS).toISOString()
  const won = await db
    .insert(tables.opsAlertState)
    .values({
      key: criticalKey(kind),
      kind,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      reported_at: nowIso,
    })
    .onConflictDoUpdate({
      target: tables.opsAlertState.key,
      set: { last_seen_at: nowIso, reported_at: nowIso },
      setWhere: or(
        isNull(tables.opsAlertState.reported_at),
        lte(tables.opsAlertState.reported_at, cutoff),
      ),
    })
    .returning({ key: tables.opsAlertState.key })
  return won.length > 0
}

async function releaseCritical(db: OpsDb, kinds: string[]): Promise<void> {
  if (!kinds.length) return
  await db
    .update(tables.opsAlertState)
    .set({ reported_at: null })
    .where(inArray(tables.opsAlertState.key, kinds.map(criticalKey)))
}

export async function sendCriticalAlerts(db: OpsDb, deps: OpsAlertDeps): Promise<CriticalResult> {
  const now = deps.now ?? new Date()
  const groups = criticalGroups(await pendingOpsEvents(db), deps.classify)
  const result: CriticalResult = { sent: [], suppressed: 0 }
  if (!groups.size) return result

  const claimed: string[] = []
  const repeats: string[] = []
  for (const [kind, rows] of groups) {
    if (await claimCritical(db, kind, now)) claimed.push(kind)
    else repeats.push(...rows.map((r) => r.id))
  }
  await settleOpsEvents(db, repeats, now)
  result.suppressed = repeats.length
  if (!claimed.length) return result

  const rows = claimed.flatMap((kind) => groups.get(kind)!)
  const digest = buildOpsDigest(rows, { ...deps.options, classify: deps.classify, now })!
  try {
    await deps.mailer(digest)
  } catch (err) {
    await releaseCritical(db, claimed)
    result.error = String(err)
    logEvent('error', 'ops_alert_send_failed', { error: result.error })
    return result
  }
  await settleOpsEvents(db, digest.ids, now)
  result.sent = claimed
  return result
}

async function readState(db: OpsDb) {
  const rows = await db
    .select()
    .from(tables.opsAlertState)
    .where(
      or(
        like(tables.opsAlertState.key, 'fp:%'),
        inArray(tables.opsAlertState.key, [DAILY_DIGEST_KEY]),
      ),
    )
  const streaks = new Map<string, Streak>()
  let lastRun: Date | null = null
  for (const row of rows) {
    if (row.key === DAILY_DIGEST_KEY) lastRun = row.reported_at ? new Date(row.reported_at) : null
    else streaks.set(row.key, row)
  }
  return { streaks, lastRun }
}

export async function runDailyDigest(db: OpsDb, deps: OpsAlertDeps): Promise<DailyResult> {
  const now = deps.now ?? new Date()
  const { streaks, lastRun } = await readState(db)
  if (!dailyDigestDue(lastRun, now)) return { due: false }

  // Critical rows still pending are a failed immediate send; the critical
  // path retries those, so the digest leaves them alone.
  const pending = await pendingOpsEvents(db)
  const critical = new Set(
    [...criticalGroups(pending, deps.classify).values()].flat().map((r) => r.id),
  )
  const rows = pending.filter((r) => !critical.has(r.id))
  const plan = planDailyDigest(rows, streaks, deps.classify, now)

  let sent = false
  if (plan.send) {
    const digest = buildOpsDigest([...plan.report, ...plan.recovered.map(recoveredRow)], {
      ...deps.options,
      classify: deps.classify,
      now,
    })!
    try {
      await deps.mailer(digest)
      sent = true
    } catch (err) {
      const error = String(err)
      logEvent('error', 'ops_alert_send_failed', { error })
      return { due: true, sent: false, error }
    }
  }

  const nowIso = now.toISOString()
  const writes: BatchItem<'sqlite'>[] = [
    ...plan.upserts.map((s) =>
      db
        .insert(tables.opsAlertState)
        .values(s)
        .onConflictDoUpdate({ target: tables.opsAlertState.key, set: s }),
    ),
    db
      .insert(tables.opsAlertState)
      .values({
        key: DAILY_DIGEST_KEY,
        kind: 'digest',
        first_seen_at: nowIso,
        last_seen_at: nowIso,
        reported_at: nowIso,
      })
      .onConflictDoUpdate({
        target: tables.opsAlertState.key,
        set: { last_seen_at: nowIso, reported_at: nowIso },
      }),
  ]
  for (let i = 0; i < plan.deletes.length; i += 50) {
    const keys = plan.deletes.slice(i, i + 50)
    writes.push(db.delete(tables.opsAlertState).where(inArray(tables.opsAlertState.key, keys)))
  }
  for (let i = 0; i < writes.length; i += 50) {
    const group = writes.slice(i, i + 50)
    await db.batch(group as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  }
  await settleOpsEvents(
    db,
    rows.map((r) => r.id),
    now,
  )
  return { due: true, sent, settled: rows.length }
}
