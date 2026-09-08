import { z } from 'zod'

import { AlertRow, contentHash, parseAgentOutput, type AgentGateResult } from '../contracts'
import type { ChangeRow } from '../contracts'

// The judge lane's contract, ported from the take-home's judge-explain.ts.
// The Worker owns the data and every gate; the routine only reasons. What
// the routine may send back is derived entirely from the AlertRow contract:
// it emits ONLY severity/headline/explanation/change_ids, and id, rule,
// created_at and provenance are stamped here from the cited change rows, so
// the model cannot smuggle them. strictObject everywhere: an extra key
// anywhere rejects the whole body.

export const JudgeAlert = AlertRow.pick({ severity: true, headline: true, explanation: true })
  .extend({ change_ids: AlertRow.shape.id.array().min(1) })
  .strict()
export type JudgeAlert = z.infer<typeof JudgeAlert>

/** What the model prints: the take-home's JudgeOutput. */
export const JudgeOutput = z.strictObject({ alerts: JudgeAlert.array() })
export type JudgeOutput = z.infer<typeof JudgeOutput>

/**
 * The POST /api/judge/alerts body. judged_through is the cursor the routine
 * is asking to advance to — the newest detected_at among the changes it was
 * handed — and change_ids_seen is what it saw, kept for the run row's count.
 */
export const JudgeSubmission = JudgeOutput.extend({
  judged_through: AlertRow.shape.fetched_at,
  change_ids_seen: z.string().min(1).array(),
}).strict()
export type JudgeSubmission = z.infer<typeof JudgeSubmission>

/** Schema gate over the raw request body — the same function the pipeline's
 * other agent lane uses, so a body that is not JSON or carries a key the
 * contract does not name is a typed rejection, never a partial write. */
export function gateJudgeSubmission(raw: string): AgentGateResult<JudgeSubmission> {
  return parseAgentOutput(raw, JudgeSubmission)
}

// ---- Stamping: gated+grounded alerts -> AlertRow --------------------------
// Everything the model did not emit is a pure function of the cited change
// records:
//   id          = contentHash(change_ids + headline) — the dedupe key
//   rule        = 'agent-judge' (never model-supplied)
//   created_at  = the newest fetched_at among the cited changes
//   provenance  = source_url/fetched_at of that newest-fetched cited change
//                 (ties keep the smallest change id — deterministic)
// change_ids are stored sorted + deduped so the id never depends on the
// model's emission order.
export function buildAlertRows(
  accepted: readonly JudgeAlert[],
  changes: readonly ChangeRow[],
): AlertRow[] {
  const byId = new Map(changes.map((c) => [c.id, c]))
  return accepted.map((alert) => {
    const ids = [...new Set(alert.change_ids)].sort()
    const cited = ids.map((id) => {
      const change = byId.get(id)
      // groundAlerts must run first; an unknown id here is a caller bug.
      if (!change) throw new Error(`buildAlertRows: change_id ${id} not among supplied changes`)
      return change
    })
    let newest = cited[0]!
    for (const c of cited.slice(1)) {
      if (Date.parse(c.fetched_at) > Date.parse(newest.fetched_at)) newest = c
    }
    return AlertRow.parse({
      id: contentHash({ change_ids: ids, headline: alert.headline }),
      severity: alert.severity,
      headline: alert.headline,
      explanation: alert.explanation,
      change_ids: JSON.stringify(ids),
      rule: 'agent-judge',
      created_at: newest.fetched_at,
      source_url: newest.source_url,
      fetched_at: newest.fetched_at,
    })
  })
}
