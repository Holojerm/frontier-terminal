// Ops alerting — the "you find out from an alert, not from a user" path.
//
// Why this exists at all: the Worker is the only component that knows what a
// failure means for the product (a source failing, the judge going quiet), not
// just that an invocation errored. Workers Issues covers the second kind. It
// writes a row here; a cron (server/tasks/ops/alert.ts) drains the rows and
// emails a digest once a row has waited out its tier's hold (OPS_HOLD_MS).
//
// Back-ported from a fork that ran it in production for a while; the one
// change is that the digest no longer hardcodes the product's name.
//
// Like server/utils/purge.ts, every function takes the Drizzle client
// explicitly so the workerd suite can drive it against a real D1 binding.

import { and, asc, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import * as tables from '../db/schema'
import type { OpsEvent } from '../db/schema'

import {
  groupOpsRows,
  opsDigestSubject,
  rankOpsKinds,
  renderOpsDigest,
  type OpsClassifier,
  type OpsSeverity,
} from './ops-digest'
import { logEvent } from './log'

export type OpsDb = ReturnType<typeof drizzle<typeof tables>>

/** How long drained rows stick around before the cron prunes them. */
export const OPS_EVENT_RETENTION_DAYS = 7

/**
 * Most rows one digest will carry. A single bad deploy can produce thousands of
 * identical errors; the email needs to say "your app is broken", not transcribe
 * every instance. Counts still reflect everything drained.
 */
export const OPS_DIGEST_SAMPLE_LIMIT = 200

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

/**
 * How long a row of each tier waits for company before the drain mails it. The
 * cron drains every five minutes, and a digest goes out once any waiting row
 * has waited out its tier's hold, carrying everything waiting, so quieter rows
 * ride along with the first louder one.
 *
 * - critical: the next drain, so at most five minutes.
 * - warning: 25 minutes, so a burst (a source flapping, one bad deploy's 5xxs)
 *   becomes one mail instead of one per drain.
 * - info: a day; alone, info makes at most one mail a day.
 */
export const OPS_HOLD_MS: Record<OpsSeverity, number> = {
  critical: 0,
  warning: 25 * MINUTE_MS,
  info: DAY_MS,
}

export interface OpsEventInput {
  kind: string
  detail?: string | null
  path?: string | null
}

/**
 * Spool an event for the next digest. Best-effort by design: this runs inside
 * error handling, and an alerting failure must never become the user's problem.
 * A swallowed insert costs one alert; a thrown one costs the request.
 *
 * Callers must `await` this. Workers cancels promises still in flight once the
 * response is sent, so a fire-and-forget call on a path that immediately throws
 * loses the row — which is exactly the path this is here to record. Awaiting is
 * safe because this never rejects.
 */
export async function recordOpsEvent(db: OpsDb, input: OpsEventInput): Promise<void> {
  try {
    await db.insert(tables.opsEvents).values({
      kind: input.kind,
      detail: input.detail?.slice(0, 500) ?? null,
      path: input.path ?? null,
    })
  } catch (err) {
    logEvent('error', 'ops_event_write_failed', { error: String(err) })
  }
}

const lastUnauthenticatedRecord = new Map<string, number>()

/** At most one row per key per minute, per isolate. */
export const UNAUTHENTICATED_OPS_INTERVAL_MS = 60_000

/**
 * `recordOpsEvent` for a path anyone can hit without credentials, such as a
 * webhook rejecting a bad signature. Unthrottled, a script could write a D1 row
 * per request and wake the owner's digest and the ops-triage routine at will.
 */
export async function recordUnauthenticatedOpsEvent(
  db: OpsDb,
  input: OpsEventInput,
  now: number = Date.now(),
): Promise<boolean> {
  const key = `${input.kind}|${input.detail ?? ''}`
  const last = lastUnauthenticatedRecord.get(key)
  if (last !== undefined && now - last < UNAUTHENTICATED_OPS_INTERVAL_MS) return false
  lastUnauthenticatedRecord.set(key, now)
  await recordOpsEvent(db, input)
  return true
}

/** Test-only. */
export function resetUnauthenticatedOpsThrottleForTest(): void {
  lastUnauthenticatedRecord.clear()
}

export interface OpsDigestOptions {
  /** Leads the subject line — the product's display name. */
  appName: string
  /** The app's public origin; turns each event's path into a link. */
  appUrl?: string
  /** The app Worker's name, for the Observability deep link. Omit to skip the link. */
  workerName?: string
  now?: Date
  /**
   * Ranks kinds by severity, tags the subject, and holds each tier for its
   * OPS_HOLD_MS. Omit it for the unranked digest, which never waits.
   */
  classify?: OpsClassifier
}

export interface OpsDigest {
  subject: string
  html: string
  text: string
  /** Rows this digest accounts for — the ones to mark notified. */
  ids: string[]
}

/**
 * Turn spooled rows into an email. Pure — no db, no network — so the wording
 * and the grouping are testable without a transport. The wording itself lives
 * in server/utils/ops-digest.ts.
 */
export function buildOpsDigest(rows: OpsEvent[], options: OpsDigestOptions): OpsDigest | null {
  if (rows.length === 0) return null
  const render = { ...options, now: options.now ?? new Date() }
  const grouped = groupOpsRows(rows)
  const kinds = options.classify ? rankOpsKinds(grouped, options.classify) : grouped
  const oldest = rows.reduce((a, b) => (a.createdAt < b.createdAt ? a : b)).createdAt

  return {
    subject: opsDigestSubject(options.appName, kinds, options.classify),
    ...renderOpsDigest(kinds, rows.length, oldest, render),
    ids: rows.map((r) => r.id),
  }
}

/** Transport for the digest. Injected so tests never touch the mail binding. */
export type OpsMailer = (digest: OpsDigest) => Promise<void>

export interface DrainResult {
  /** Rows found waiting (capped at OPS_DIGEST_SAMPLE_LIMIT). */
  pending: number
  /** True when a digest was handed to the mailer and accepted. */
  sent: boolean
  /** Rows deleted by the retention sweep. */
  pruned: number
  /** True when rows were waiting but none had waited out its tier's hold (OPS_HOLD_MS). */
  held?: boolean
  error?: string
}

/**
 * One cron tick: drain, notify, prune.
 *
 * Rows are marked notified only after the mailer resolves. If sending fails the
 * rows stay pending and the next tick retries — an alerting system that loses
 * the alert when the mail hiccups is worse than no alerting system, because it
 * lies about coverage.
 */
export async function drainOpsEvents(
  db: OpsDb,
  mail: OpsMailer,
  options: OpsDigestOptions,
): Promise<DrainResult> {
  const now = options.now ?? new Date()

  const pending = await db
    .select()
    .from(tables.opsEvents)
    .where(isNull(tables.opsEvents.notifiedAt))
    .orderBy(asc(tables.opsEvents.createdAt))
    .limit(OPS_DIGEST_SAMPLE_LIMIT)

  let sent = false
  let error: string | undefined

  if (holdOpsDigest(pending, options.classify, now)) {
    const pruned = await pruneOpsEvents(db, now)
    return { pending: pending.length, sent, pruned, held: true }
  }

  const digest = buildOpsDigest(pending, { ...options, now })
  if (digest) {
    try {
      await mail(digest)
      sent = true
      // Chunked so a large drain can't build a SQL statement D1 will reject.
      for (let i = 0; i < digest.ids.length; i += 50) {
        const chunk = digest.ids.slice(i, i + 50)
        await db
          .update(tables.opsEvents)
          .set({ notifiedAt: now })
          .where(and(isNull(tables.opsEvents.notifiedAt), inArray(tables.opsEvents.id, chunk)))
      }
    } catch (err) {
      error = String(err)
      logEvent('error', 'ops_alert_send_failed', { error })
    }
  }

  const pruned = await pruneOpsEvents(db, now)

  return { pending: pending.length, sent, pruned, error }
}

/**
 * True when rows are waiting and no kind's oldest row has waited out the hold
 * for that kind's tier (OPS_HOLD_MS). A kind is tiered by its count, as the
 * digest tiers it, so a server_error burst is critical and goes at once. Held
 * rows stay pending; nothing is dropped.
 */
export function holdOpsDigest(
  pending: OpsEvent[],
  classify: OpsClassifier | undefined,
  now: Date,
): boolean {
  if (!classify || pending.length === 0) return false
  return groupOpsRows(pending).every(([kind, rows]) => {
    const oldest = Math.min(...rows.map((r) => r.createdAt.getTime()))
    return now.getTime() - oldest < OPS_HOLD_MS[classify(kind, rows.length).severity]
  })
}

/**
 * Retention sweep, separate from the drain so the cron can run it when alerting
 * is unconfigured. Without that, a fork with no `ALERT_EMAIL` binding spooled
 * rows forever: the drain was the only thing that deleted them. Returns the
 * number of rows removed.
 */
export async function pruneOpsEvents(db: OpsDb, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - OPS_EVENT_RETENTION_DAYS * DAY_MS)
  const pruned = await db
    .delete(tables.opsEvents)
    .where(lt(tables.opsEvents.createdAt, cutoff))
    .returning({ id: tables.opsEvents.id })
  return pruned.length
}

/** Most rows one read of the spool returns; retention caps the window at a week. */
export const OPS_EVENTS_READ_LIMIT = 500

export interface RecentOpsEvent {
  id: string
  kind: string
  detail: string | null
  path: string | null
  created_at: string
  notified_at: string | null
}

/**
 * The spool as the digest saw it, newest first, for the ops-triage routine
 * (GET /api/ops/events). Notified rows are included: the digest marks rows
 * when it mails them, and the routine reads after that.
 */
export async function recentOpsEvents(
  db: OpsDb,
  options: { hours: number; kind?: string; now?: Date },
): Promise<RecentOpsEvent[]> {
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - options.hours * 60 * 60 * 1000)
  const rows = await db
    .select()
    .from(tables.opsEvents)
    .where(
      and(
        gte(tables.opsEvents.createdAt, since),
        options.kind ? eq(tables.opsEvents.kind, options.kind) : undefined,
      ),
    )
    .orderBy(desc(tables.opsEvents.createdAt))
    .limit(OPS_EVENTS_READ_LIMIT)
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    detail: r.detail,
    path: r.path,
    created_at: r.createdAt.toISOString(),
    notified_at: r.notifiedAt?.toISOString() ?? null,
  }))
}
