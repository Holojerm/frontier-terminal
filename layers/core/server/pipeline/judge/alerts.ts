import { z } from 'zod'

import { AlertRow, contentHash, type ChangeRow } from '../contracts'

// The alert half of the judge lane's contract (the reviews each domain adds are
// in layers/terminal/server/pipeline/judge/contract.ts). The Worker owns the data and
// every gate; the routine only reasons. What the routine may send back is derived entirely from the AlertRow contract:
// it emits ONLY severity/headline/explanation/change_ids, and id, rule,
// created_at and provenance are stamped here from the cited change rows, so
// the model cannot smuggle them. strictObject everywhere: an extra key
// anywhere rejects the whole body.

export const JudgeAlert = AlertRow.pick({ severity: true, headline: true, explanation: true })
  .extend({ change_ids: AlertRow.shape.id.array().min(1) })
  .strict()
export type JudgeAlert = z.infer<typeof JudgeAlert>

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
