import { inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  JUDGE_ALERT_SCREEN,
  JUDGE_REVIEWS,
  type JudgeScreenOptions,
} from '#server/registries/judge'
import { buildAlertRows } from './alerts'
import { gateJudgeSubmission, type JudgeSubmission } from './contract'
import { groundAlerts, type AlertGroundingRejection } from './grounding'
import { judgedThrough, pendingChanges } from './pending'
import { reviewRejectionDetail, type JudgeClamp } from './review'

// POST /api/judge/alerts, minus the request: raw body -> schema gate ->
// cursor check -> the offered window -> grounding against the cited change
// rows as D1 holds them -> the alert screen (server/registries/judge.ts ›
// JUDGE_ALERT_SCREEN: what each domain gates an alert on) -> stamping -> the
// one write chokepoint -> a judge_runs row -> each review's readings
// (JUDGE_REVIEWS). Every model-output rejection is a return value and an ops
// event, never an exception; only D1 itself can throw here.

export const JUDGE_OPS_PATH = '/api/judge/alerts'

/**
 * What a run hands its `judge:applied` subscribers once every reading is
 * stored: the theses layer re-evaluates its judged claims on it
 * (layers/theses/server/plugins/theses-judged.ts), so the judge never
 * imports the code that reads its verdicts.
 */
export interface JudgeAppliedContext {
  db: PipelineDb
  sourcesYaml: string
  now: Date
}

export type JudgeAppliedHook = (ctx: JudgeAppliedContext) => void | Promise<void>

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    'judge:applied': JudgeAppliedHook
  }
}

export interface JudgeRunReport {
  /** Change ids the routine said it looked at. */
  changes_seen: number
  /** Alerts that passed the gate, grounding and the screen's rejections. */
  accepted: number
  /** Accepted alerts written: accepted minus the ones already stored. */
  inserted: number
  /** Rejected alerts: real model output that cited something it couldn't. */
  rejected: number
  rejections: { reason: string; detail: string; headline: string }[]
  /** Alerts stored below the severity sent (the screen's floors and gates). */
  clamped: JudgeClamp[]
  /** Whole-body rejection at the schema gate or the cursor check; nothing reached grounding. */
  gate_rejection: { reason: string; detail: string } | null
  /** Each review's report, under its key (JUDGE_REVIEWS). */
  [review: string]: unknown
}

async function loadChanges(db: PipelineDb, ids: readonly string[]): Promise<ChangeRow[]> {
  const rows: ChangeRow[] = []
  for (const group of chunk([...new Set(ids)], D1_MAX_BOUND_PARAMS)) {
    const found = await db.select().from(tables.changes).where(inArray(tables.changes.id, group))
    for (const row of found) rows.push(ChangeRow.parse(row))
  }
  return rows
}

async function existingAlertIds(db: PipelineDb, ids: readonly string[]): Promise<Set<string>> {
  const existing = new Set<string>()
  for (const group of chunk(ids, D1_MAX_BOUND_PARAMS)) {
    const found = await db
      .select({ id: tables.alerts.id })
      .from(tables.alerts)
      .where(inArray(tables.alerts.id, group))
    for (const row of found) existing.add(row.id)
  }
  return existing
}

/**
 * The cursor this run may store, or why `judged_through` is not one. It must
 * be the newest detected_at among the changes the run says it saw, not behind
 * the current cursor and not past the newest change GET /api/judge/pending
 * offers from it; otherwise changes are stranded or re-offered. A review-only
 * run holds the cursor. Compared as instants: "…:00Z" and "…:00.000Z" are one
 * cursor.
 */
export async function checkCursor(
  db: PipelineDb,
  body: Pick<JudgeSubmission, 'judged_through' | 'change_ids_seen'>,
): Promise<{ ok: true; through: string | null } | { ok: false; detail: string }> {
  const prev = await judgedThrough(db)
  const at = Date.parse(body.judged_through)
  const through = new Date(at).toISOString()
  if (prev !== null && at < Date.parse(prev)) {
    return {
      ok: false,
      detail: `judged_through ${body.judged_through} is behind the cursor ${prev}`,
    }
  }
  const seen = await loadChanges(db, body.change_ids_seen)
  if (seen.length === 0) {
    if (prev === null) return { ok: true, through: null }
    return at === Date.parse(prev)
      ? { ok: true, through }
      : {
          ok: false,
          detail: `no change was seen, so judged_through must stay at the cursor ${prev}`,
        }
  }
  const end = (await pendingChanges(db)).through ?? prev
  if (end === null || at > Date.parse(end)) {
    return {
      ok: false,
      detail: `judged_through ${body.judged_through} is past the newest change offered (${end ?? 'none'})`,
    }
  }
  const newestSeen = Math.max(...seen.map((c) => Date.parse(c.detected_at)))
  if (at !== newestSeen) {
    return {
      ok: false,
      detail: `judged_through ${body.judged_through} is not the newest detected_at among the changes seen (${new Date(newestSeen).toISOString()})`,
    }
  }
  return { ok: true, through }
}

/**
 * Alerts that cite a change outside the window this run was offered: detected
 * after the previous cursor and no later than judged_through. Without this a
 * run could cite any change ever stored, judged already or never offered. An
 * alert already stored is a repeat of a run that landed, and passes on to the
 * dedupe below rather than reading as a rejection.
 */
function outsideWindow(
  alerts: JudgeSubmission['alerts'],
  cited: readonly ChangeRow[],
  prev: string | null,
  through: string | null,
  stored: ReadonlySet<string>,
): { inside: JudgeSubmission['alerts']; rejected: AlertGroundingRejection[] } {
  const from = prev === null ? -Infinity : Date.parse(prev)
  // No cursor and none set: nothing was offered.
  const to = through === null ? -Infinity : Date.parse(through)
  const offered = new Set(
    cited
      .filter((c) => {
        const at = Date.parse(c.detected_at)
        return at > from && at <= to
      })
      .map((c) => c.id),
  )
  const known = new Set(cited.map((c) => c.id))
  const inside: JudgeSubmission['alerts'] = []
  const rejected: AlertGroundingRejection[] = []
  for (const alert of alerts) {
    const outside = alert.change_ids.filter((id) => !offered.has(id))
    if (outside.length === 0 || stored.has(stampedId(alert))) {
      inside.push(alert)
      continue
    }
    // An id not stored at all is grounding's unknown-change-id; this is only
    // for real changes the run was not handed.
    const unoffered = outside.filter((id) => known.has(id))
    if (unoffered.length === 0) {
      inside.push(alert)
      continue
    }
    rejected.push({
      alert,
      reason: 'unoffered-change-id',
      detail: `change_id(s) outside this run's window (${prev ?? 'start'}, ${through}]: ${unoffered.join(', ')}`,
    })
  }
  return { inside, rejected }
}

/** The id buildAlertRows will stamp: the dedupe key. */
const stampedId = (alert: { change_ids: readonly string[]; headline: string }) =>
  contentHash({ change_ids: [...new Set(alert.change_ids)].sort(), headline: alert.headline })

/** No stored pages: every review that reads one rejects for want of it. */
const NO_PAGES: RawReader = async () => null

/** Every review's report for a run whose body was rejected whole, in registry order. */
const emptyReports = (): Record<string, unknown> =>
  Object.fromEntries(JUDGE_REVIEWS.map((r) => [r.key, structuredClone(r.empty)]))

export async function submitJudgeRun(
  db: PipelineDb,
  raw: string,
  opts: {
    source?: string
    now?: Date
    readRaw?: RawReader
    sourcesYaml?: string
    /**
     * Called after every reading is applied, when sourcesYaml is given. The
     * route passes the Nitro `judge:applied` hook; a test passes its subscriber.
     */
    applied?: JudgeAppliedHook
  } & JudgeScreenOptions = {},
): Promise<JudgeRunReport> {
  const started_at = (opts.now ?? new Date()).toISOString()
  const source = opts.source ?? 'routine'

  const gate = gateJudgeSubmission(raw)
  if (!gate.ok) {
    // The run is recorded so the silence watchdog sees a live routine, but
    // judged_through stays NULL: nothing was judged, so nothing advances.
    const reason = `${gate.reason}: ${gate.detail}`
    await db.insert(tables.judgeRuns).values({
      id: crypto.randomUUID(),
      started_at,
      judged_through: null,
      changes_seen: 0,
      accepted: 0,
      rejected: 0,
      rejection_reason: reason.slice(0, 500),
      source,
    })
    await recordOpsEvent(db, {
      kind: 'judge_rejected',
      detail: `body rejected at the schema gate (${reason})`,
      path: JUDGE_OPS_PATH,
    })
    return {
      changes_seen: 0,
      accepted: 0,
      inserted: 0,
      rejected: 0,
      rejections: [],
      clamped: [],
      gate_rejection: { reason: gate.reason, detail: gate.detail },
      ...emptyReports(),
    }
  }

  const body = gate.value
  const prev = await judgedThrough(db)
  const cursor = await checkCursor(db, body)
  if (!cursor.ok) {
    const badCursor = cursor.detail
    await db.insert(tables.judgeRuns).values({
      id: crypto.randomUUID(),
      started_at,
      judged_through: null,
      changes_seen: body.change_ids_seen.length,
      accepted: 0,
      rejected: 0,
      rejection_reason: `cursor: ${badCursor}`.slice(0, 500),
      source,
    })
    await recordOpsEvent(db, {
      kind: 'judge_rejected',
      detail: `body rejected at the cursor check (${badCursor})`,
      path: JUDGE_OPS_PATH,
    })
    return {
      changes_seen: 0,
      accepted: 0,
      inserted: 0,
      rejected: 0,
      rejections: [],
      clamped: [],
      gate_rejection: { reason: 'cursor', detail: badCursor },
      ...emptyReports(),
    }
  }

  // Grounding reads the change rows from D1, not from the body: the routine
  // never gets to say what a change contained.
  const cited = await loadChanges(
    db,
    body.alerts.flatMap((alert) => alert.change_ids),
  )
  const stored = await existingAlertIds(db, body.alerts.map(stampedId))
  const windowed = outsideWindow(body.alerts, cited, prev, cursor.through ?? prev, stored)
  const grounded = groundAlerts(windowed.inside, cited)
  // What each domain gates an alert on, after grounding: it may reject an
  // alert or lower its severity, and applies the reviews the alerts depend on.
  const screened = await JUDGE_ALERT_SCREEN({
    db,
    readRaw: opts.readRaw ?? NO_PAGES,
    now: opts.now ?? new Date(),
    sourcesYaml: opts.sourcesYaml,
    options: opts,
    body,
    alerts: grounded.accepted,
    cited,
  })
  const accepted = screened.accepted
  const rejected = [...windowed.rejected, ...grounded.rejected, ...screened.rejected]
  const rejections = rejected.map((r) => ({
    reason: r.reason,
    detail: r.detail,
    headline: r.alert.headline,
  }))

  const rows = buildAlertRows(screened.alerts, cited)
  // Dedupe on the stamped id: the same headline over the same change ids is
  // the same alert, and a routine that judged twice is not an error.
  const existing = await existingAlertIds(
    db,
    rows.map((row) => row.id),
  )
  const fresh = rows.filter((row) => !existing.has(row.id))
  const inserted = await insertRows(db, 'alerts', fresh)
  if (inserted) await emitEvent('alerts.new')

  await db.insert(tables.judgeRuns).values({
    id: crypto.randomUUID(),
    started_at,
    // Stored as toISOString so every cursor reads the same way.
    judged_through: cursor.through,
    changes_seen: body.change_ids_seen.length,
    accepted: accepted.length,
    rejected: rejected.length,
    rejection_reason:
      rejections.length === 0
        ? null
        : rejections
            .map((r) => `${r.reason}: ${r.detail}`)
            .join(' | ')
            .slice(0, 500),
    source,
  })

  if (rejections.length > 0) {
    const [first] = rejections
    await recordOpsEvent(db, {
      kind: 'judge_rejected',
      detail: `${rejections.length} alert(s) failed grounding; first: ${first!.reason} — ${first!.detail} (headline: ${first!.headline})`,
      path: JUDGE_OPS_PATH,
    })
  }

  // Verdicts land after the cursor row, so a judged claim's status reads
  // this run as coverage; the status log is updated here rather than
  // waiting for the next survey tick.
  const now = opts.now ?? new Date()
  const reports: Record<string, unknown> = {}
  for (const review of JUDGE_REVIEWS) {
    if (!review.apply) continue
    const report = await review.apply(
      { db, readRaw: opts.readRaw ?? NO_PAGES, now },
      body[review.key] ?? [],
    )
    reports[review.key] = report
    const detail = reviewRejectionDetail(review, report)
    if (detail) await recordOpsEvent(db, { kind: 'judge_rejected', detail, path: JUDGE_OPS_PATH })
  }
  if (opts.sourcesYaml) await opts.applied?.({ db, sourcesYaml: opts.sourcesYaml, now })

  return {
    ...reports,
    changes_seen: body.change_ids_seen.length,
    accepted: accepted.length,
    inserted,
    rejected: rejected.length,
    rejections,
    clamped: screened.clamped,
    gate_rejection: null,
    ...screened.reports,
  }
}
