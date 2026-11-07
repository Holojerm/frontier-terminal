// What the alert mailer (ops-alerts.ts) mails and what it only records. Pure:
// no db, no clock, so every rule here is tested without D1.
//
// The rules, each sized against a week of production spool (2026-11-07: ~13
// emails a day, nearly all repeats of the same few warnings):
//
//   - A critical kind is mailed at once, then not again for
//     CRITICAL_COOLDOWN_MS. A Workers Issue that fires five times in an hour
//     is one email.
//   - Everything else waits for one daily digest at DAILY_DIGEST_HOUR_UTC,
//     and a quiet day sends nothing.
//   - Inside that digest a failure is reported once per streak: the same
//     kind failing for the same reason (fingerprint()) on every run is one
//     line on the day it starts, not one per run. A streak ends after
//     STREAK_GAP_MS without a repeat; the next digest notes it recovered.
//   - Rate limits, blocks, timeouts and upstream 5xxs (isTransient()) are
//     not reported until their streak has lasted TRANSIENT_THRESHOLD_MS. An
//     npm 429 that clears by the next poll is never mailed.

import type { OpsEvent } from '#server/db/schema'
import type { OpsClassifier } from '#server/utils/ops-digest'
import { formatOpsTime, opsKindLabel } from '#server/utils/ops-digest'

const HOUR_MS = 60 * 60 * 1000

export const CRITICAL_COOLDOWN_MS = 6 * HOUR_MS
export const TRANSIENT_THRESHOLD_MS = 6 * HOUR_MS
/** Longer than the slowest poll that can fail (the six-hourly survey), with room for a missed tick. */
export const STREAK_GAP_MS = 24 * HOUR_MS
/** 8 or 9 am in New York, beside the weekly thesis digest. */
export const DAILY_DIGEST_HOUR_UTC = 13

/** The synthetic kind a recovered streak is listed under. Registered as info. */
export const OPS_RECOVERED_KIND = 'ops_recovered'

const TRANSIENT = /\bHTTP (?:403|408|429|5\d\d)\b|TimeoutError|timed out|\btimeout\b/i

export function isTransient(detail: string | null): boolean {
  return TRANSIENT.test(detail ?? '')
}

/**
 * The reason, without what varies between runs of one failure: alert ids,
 * attempt counts, retry delays. Three-digit numbers that look like HTTP
 * statuses stay, because a 403 and a 429 are different problems.
 */
export function normalizeDetail(detail: string | null): string {
  return (detail ?? '')
    .replace(/\b[0-9a-f]{12,}\b/gi, '#')
    .replace(/\b(?![1-5]\d\d\b)\d+(?:\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

export function fingerprint(kind: string, detail: string | null): string {
  return `fp:${kind}:${normalizeDetail(detail)}`
}

export function criticalKey(kind: string): string {
  return `critical:${kind}`
}

/** Pending rows of each kind the classifier calls critical, given that kind's count. */
export function criticalGroups(rows: OpsEvent[], classify: OpsClassifier): Map<string, OpsEvent[]> {
  const byKind = new Map<string, OpsEvent[]>()
  for (const row of rows) {
    const bucket = byKind.get(row.kind)
    if (bucket) bucket.push(row)
    else byKind.set(row.kind, [row])
  }
  for (const [kind, group] of byKind) {
    if (classify(kind, group.length).severity !== 'critical') byKind.delete(kind)
  }
  return byKind
}

/**
 * True from DAILY_DIGEST_HOUR_UTC until a digest run is recorded for today.
 * A tick that misses the hour (a deploy, a failed send) is caught by the next.
 */
export function dailyDigestDue(lastRun: Date | null, now: Date): boolean {
  if (now.getUTCHours() < DAILY_DIGEST_HOUR_UTC) return false
  const slot = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    DAILY_DIGEST_HOUR_UTC,
  )
  return !lastRun || lastRun.getTime() < slot
}

/** One failure streak, as stored in ops_alert_state. Times are ISO strings. */
export interface Streak {
  key: string
  kind: string
  detail: string | null
  first_seen_at: string
  last_seen_at: string
  reported_at: string | null
}

export interface DigestPlan {
  /** Rows to mail: every row of each streak reported for the first time. */
  report: OpsEvent[]
  /** Streaks a digest reported that have now gone quiet for STREAK_GAP_MS. */
  recovered: Streak[]
  /** Streak rows to write back. */
  upserts: Streak[]
  /** Streak keys to delete: ended, reported or not. */
  deletes: string[]
  /** False when nothing above info is newly reported: a quiet day sends nothing. */
  send: boolean
}

/**
 * Decide one daily digest from the non-critical rows pending since the last
 * one and the streaks remembered from before. Every pending row is settled by
 * the caller whatever this returns; only `report` is mailed.
 */
export function planDailyDigest(
  rows: OpsEvent[],
  streaks: Map<string, Streak>,
  classify: OpsClassifier,
  now: Date,
): DigestPlan {
  const groups = new Map<string, OpsEvent[]>()
  for (const row of rows) {
    const key = fingerprint(row.kind, row.detail)
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }

  const plan: DigestPlan = { report: [], recovered: [], upserts: [], deletes: [], send: false }
  const nowIso = now.toISOString()

  for (const [key, group] of groups) {
    const times = group.map((r) => r.createdAt.getTime())
    const first = Math.min(...times)
    const last = Math.max(...times)
    const latest = group.find((r) => r.createdAt.getTime() === last)!
    const prev = streaks.get(key)
    const continuing = prev && Date.parse(prev.last_seen_at) >= first - STREAK_GAP_MS

    const streak: Streak = continuing
      ? {
          ...prev,
          detail: latest.detail,
          last_seen_at: new Date(Math.max(last, Date.parse(prev.last_seen_at))).toISOString(),
        }
      : {
          key,
          kind: latest.kind,
          detail: latest.detail,
          first_seen_at: new Date(first).toISOString(),
          last_seen_at: new Date(last).toISOString(),
          reported_at: null,
        }

    const lasted = Date.parse(streak.last_seen_at) - Date.parse(streak.first_seen_at)
    const due =
      streak.reported_at === null &&
      (!isTransient(streak.detail) || lasted >= TRANSIENT_THRESHOLD_MS)
    if (due) {
      streak.reported_at = nowIso
      plan.report.push(...group)
      if (classify(streak.kind, group.length).severity !== 'info') plan.send = true
    }
    plan.upserts.push(streak)
  }

  for (const [key, streak] of streaks) {
    if (groups.has(key)) continue
    if (now.getTime() - Date.parse(streak.last_seen_at) < STREAK_GAP_MS) continue
    plan.deletes.push(key)
    if (streak.reported_at) plan.recovered.push(streak)
  }

  return plan
}

/** A recovered streak as a digest row, so it renders like any other kind. */
export function recoveredRow(streak: Streak): OpsEvent {
  const last = new Date(streak.last_seen_at)
  return {
    id: `recovered:${streak.key}`,
    kind: OPS_RECOVERED_KIND,
    detail: `${opsKindLabel(streak.kind)} · ${streak.detail ?? ''} (failing ${formatOpsTime(new Date(streak.first_seen_at))} to ${formatOpsTime(last)})`,
    path: null,
    notifiedAt: null,
    createdAt: last,
    updatedAt: last,
  }
}
