import { inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import { ChangeRow, contentHash } from '../contracts'
import { D1_MAX_BOUND_PARAMS, chunk, insertRows, type PipelineDb } from '../store'
import { applyClaimVerdicts, type VerdictReport } from '../../theses/verdicts'
import { applyFigureReadings, type FigureReport } from '../reported/review'
import { applyFilingReadings, type FilingReport } from './filing-review'
import { applyTrackRecordVerdicts, type TrackRecordVerdictReport } from '../track-record/review'
import { evaluateTheses } from '../../theses/evaluate'
import { parseDepartmentClusters, type DepartmentCluster } from '../../utils/terminal-clusters'
import { effectiveClassMap } from '../class-map'
import { clampHiringAlerts, type FloorClamp } from '../hiring-floor'
import { clampRoutineAlerts } from './severity-gates'
import { applyClassMappings, type RawReader } from './class-map'
import { emitEvent } from '../../utils/events'
import { buildAlertRows, gateJudgeSubmission, type JudgeSubmission } from './contract'
import { groundAlerts, type AlertGroundingRejection } from './grounding'
import { judgedThrough, pendingChanges } from './pending'
import { rejectFalseDelistings, stillListedRemovals } from './still-listed'

// POST /api/judge/alerts, minus the request: raw body -> schema gate ->
// cursor check -> the offered window -> grounding against the cited change
// rows as D1 holds them -> no still-listed model called delisted -> the hiring
// materiality floor (layers/terminal/server/pipeline/hiring-floor.ts) -> stamping ->
// the one write chokepoint -> a judge_runs row. Every model-output
// rejection is a return value and an ops event, never an exception; only
// D1 itself can throw here.

export const JUDGE_OPS_PATH = '/api/judge/alerts'

export interface JudgeRunReport {
  /** Change ids the routine said it looked at. */
  changes_seen: number
  /** Alerts that passed the gate AND grounding. */
  accepted: number
  /** Accepted alerts written — accepted minus the ones already stored. */
  inserted: number
  /** Grounded-out alerts: real model output that cited something it couldn't. */
  rejected: number
  rejections: { reason: string; detail: string; headline: string }[]
  /** Hiring alerts stored below the severity sent: under the floor, or a cut emptying no department. */
  clamped: FloorClamp[]
  /** Whole-body rejection at the schema gate or the cursor check — nothing reached grounding. */
  gate_rejection: { reason: string; detail: string } | null
  /** Re-mappings of matrix cells under review (layers/terminal/server/pipeline/judge/class-map.ts). */
  class_map: {
    accepted: number
    rejected: { reason: string; detail: string; cell: string; model_slug: string }[]
  }
  /** Verdicts on judged thesis claims (layers/terminal/server/theses/verdicts.ts). */
  claims: VerdictReport
  /** Same-event ratings of track-record candidates (layers/terminal/server/pipeline/track-record/review.ts). */
  track_record: TrackRecordVerdictReport
  /** Labeled figures in press headlines (layers/terminal/server/pipeline/reported/review.ts). */
  figures: FigureReport
  /** Registration-filing parts the parser could not read (judge/filing-review.ts). */
  filings: FilingReport
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
 * The cursor this run may store, or why `judged_through` is not one. The
 * routine sends the newest detected_at it was handed; anything else either
 * strands changes behind the cursor (too far ahead) or re-offers judged ones
 * (behind). It must not go back, must not pass the newest change GET
 * /api/judge/pending offers from the current cursor, and must be the newest
 * detected_at among the changes the run says it saw. A run that saw none (a
 * review-only run) holds the cursor where it is, and before the first cursor
 * stores none. Compared as instants: "…:00Z" and "…:00.000Z" are one cursor.
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

/** The id buildAlertRows will stamp — the dedupe key. */
const stampedId = (alert: { change_ids: readonly string[]; headline: string }) =>
  contentHash({ change_ids: [...new Set(alert.change_ids)].sort(), headline: alert.headline })

/** No stored pages: every class-map proposal is rejected for want of one. */
const NO_PAGES: RawReader = async () => null

export async function submitJudgeRun(
  db: PipelineDb,
  raw: string,
  opts: {
    source?: string
    now?: Date
    readRaw?: RawReader
    sourcesYaml?: string
    /** The buildout clusters the floor reads; parsed from sourcesYaml when omitted. */
    clusters?: readonly DepartmentCluster[]
  } = {},
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
      class_map: { accepted: 0, rejected: [] },
      claims: { accepted: 0, inserted: 0, rejected: [] },
      track_record: { accepted: 0, inserted: 0, rejected: [] },
      figures: { accepted: 0, inserted: 0, rejected: [] },
      filings: { accepted: 0, alerts: 0, rejected: [] },
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
      class_map: { accepted: 0, rejected: [] },
      claims: { accepted: 0, inserted: 0, rejected: [] },
      track_record: { accepted: 0, inserted: 0, rejected: [] },
      figures: { accepted: 0, inserted: 0, rejected: [] },
      filings: { accepted: 0, alerts: 0, rejected: [] },
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
  // Read at submit time: a page that drops the model between the pending
  // read and now makes the removal a real delisting.
  const stillListed = await stillListedRemovals(db, cited)
  const listed = rejectFalseDelistings(grounded.accepted, cited, stillListed)
  const accepted = listed.accepted
  const rejected = [...windowed.rejected, ...grounded.rejected, ...listed.rejected]
  const rejections = rejected.map((r) => ({
    reason: r.reason,
    detail: r.detail,
    headline: r.alert.headline,
  }))

  // The floor runs after grounding and only lowers severity: whatever the
  // routine sent, a hiring move below it is stored as a ticker line, and a
  // critical net cut that empties no department is stored as notable.
  const clusters =
    opts.clusters ?? (opts.sourcesYaml ? parseDepartmentClusters(opts.sourcesYaml) : [])
  const floored = await clampHiringAlerts(db, accepted, cited, clusters)
  const matrix = await effectiveClassMap(db)
  const gated = clampRoutineAlerts(
    floored.alerts,
    cited,
    new Set(matrix.map((e) => `${e.provider}:${e.model_slug}`)),
    new Set(stillListed.map((r) => r.change_id)),
  )

  const rows = buildAlertRows(gated.alerts, cited)
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

  // Re-mappings are gated against the stored page, never against the body.
  const classMap = await applyClassMappings(
    db,
    opts.readRaw ?? NO_PAGES,
    body.class_map,
    opts.now ?? new Date(),
  )

  // Verdicts land after the cursor row, so a judged claim's status reads
  // this run as coverage; the status log is updated here rather than
  // waiting for the next survey tick.
  const now = opts.now ?? new Date()
  const claims = await applyClaimVerdicts(db, body.claims, now)
  if (claims.rejected.length > 0) {
    const [first] = claims.rejected
    await recordOpsEvent(db, {
      kind: 'judge_rejected',
      detail: `${claims.rejected.length} claim verdict(s) rejected; first: ${first!.reason} — ${first!.detail} (${first!.claim_id})`,
      path: JUDGE_OPS_PATH,
    })
  }
  const track_record = await applyTrackRecordVerdicts(db, body.track_record, now)
  if (track_record.rejected.length > 0) {
    const [first] = track_record.rejected
    await recordOpsEvent(db, {
      kind: 'judge_rejected',
      detail: `${track_record.rejected.length} track-record rating(s) rejected; first: ${first!.reason} — ${first!.detail} (${first!.candidate_id})`,
      path: JUDGE_OPS_PATH,
    })
  }
  const figures = await applyFigureReadings(db, body.figures, now)
  if (figures.rejected.length > 0) {
    const [first] = figures.rejected
    await recordOpsEvent(db, {
      kind: 'judge_rejected',
      detail: `${figures.rejected.length} figure reading(s) rejected; first: ${first!.reason} — ${first!.detail} (${first!.article_id})`,
      path: JUDGE_OPS_PATH,
    })
  }
  const filings = await applyFilingReadings(db, opts.readRaw ?? NO_PAGES, body.filings, now)
  if (filings.rejected.length > 0) {
    const [first] = filings.rejected
    await recordOpsEvent(db, {
      kind: 'judge_rejected',
      detail: `${filings.rejected.length} filing reading(s) rejected; first: ${first!.reason} — ${first!.detail} (${first!.source_id})`,
      path: JUDGE_OPS_PATH,
    })
  }
  if (opts.sourcesYaml) {
    await evaluateTheses(db, { sourcesYaml: opts.sourcesYaml, now: () => now }, undefined, {
      judgedOnly: true,
    })
  }

  return {
    claims,
    track_record,
    figures,
    filings,
    changes_seen: body.change_ids_seen.length,
    accepted: accepted.length,
    inserted,
    rejected: rejected.length,
    rejections,
    clamped: [...floored.clamped, ...gated.clamped],
    gate_rejection: null,
    class_map: {
      accepted: classMap.accepted,
      rejected: classMap.rejected.map((r) => ({
        reason: r.reason,
        detail: r.detail,
        cell: `${r.mapping.provider}:${r.mapping.class}`,
        model_slug: r.mapping.model_slug,
      })),
    },
  }
}
