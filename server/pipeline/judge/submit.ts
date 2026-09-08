import { inArray } from 'drizzle-orm'

import * as tables from '../../db/schema'
import { recordOpsEvent } from '../../utils/ops'
import { ChangeRow } from '../contracts'
import { D1_MAX_BOUND_PARAMS, chunk, insertRows, type PipelineDb } from '../store'
import { buildAlertRows, gateJudgeSubmission } from './contract'
import { groundAlerts } from './grounding'

// POST /api/judge/alerts, minus the request: raw body -> schema gate ->
// grounding against the cited change rows as D1 holds them -> stamping ->
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
  /** Whole-body rejection at the schema gate — nothing reached grounding. */
  gate_rejection: { reason: string; detail: string } | null
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

export async function submitJudgeRun(
  db: PipelineDb,
  raw: string,
  opts: { source?: string; now?: Date } = {},
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
      gate_rejection: { reason: gate.reason, detail: gate.detail },
    }
  }

  const body = gate.value
  // Grounding reads the change rows from D1, not from the body: the routine
  // never gets to say what a change contained.
  const cited = await loadChanges(
    db,
    body.alerts.flatMap((alert) => alert.change_ids),
  )
  const { accepted, rejected } = groundAlerts(body.alerts, cited)
  const rejections = rejected.map((r) => ({
    reason: r.reason,
    detail: r.detail,
    headline: r.alert.headline,
  }))

  const rows = buildAlertRows(accepted, cited)
  // Dedupe on the stamped id: the same headline over the same change ids is
  // the same alert, and a routine that judged twice is not an error.
  const existing = await existingAlertIds(
    db,
    rows.map((row) => row.id),
  )
  const fresh = rows.filter((row) => !existing.has(row.id))
  const inserted = await insertRows(db, 'alerts', fresh)

  await db.insert(tables.judgeRuns).values({
    id: crypto.randomUUID(),
    started_at,
    judged_through: body.judged_through,
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

  return {
    changes_seen: body.change_ids_seen.length,
    accepted: accepted.length,
    inserted,
    rejected: rejected.length,
    rejections,
    gate_rejection: null,
  }
}
