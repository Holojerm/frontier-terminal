import { z } from 'zod'

import {
  AlertRow,
  parseAgentOutput,
  type AgentGateResult,
} from '#layers/core/server/pipeline/contracts'
import { JudgeAlert } from '#layers/core/server/pipeline/judge/alerts'
import { JudgeClaimVerdict } from '../../theses/verdicts'
import { JudgeFigureReading } from '../reported/review'
import { JudgeGuidanceReading } from '../../calls/review'
import { JudgePowerSiteReading } from '../../power/review'
import { JudgeSupplierReading } from '../../suppliers/review'
import { JudgeTrackRecordVerdict } from '../track-record/review'
import { JudgeClassMapping } from './class-map'
import { JudgeFilingReading } from './filing-review'
import { JudgePriceReading } from './price-review'

// The judge lane's whole contract: the alert half (layers/core/server/pipeline/judge/alerts.ts)
// plus each review a domain hands the routine. strictObject everywhere: an
// extra key anywhere rejects the whole body.

/**
 * What the model prints. `class_map` is optional so a run with no cell under
 * review prints exactly what it always did; the Worker gates each entry in
 * layers/terminal/server/pipeline/judge/class-map.ts.
 */
export const JudgeOutput = z.strictObject({
  alerts: JudgeAlert.array(),
  class_map: JudgeClassMapping.array().max(9).default([]),
  /** Verdicts on judged thesis claims, one per candidate in a CLAIM REVIEW block. */
  claims: JudgeClaimVerdict.array().max(200).default([]),
  /** Same-event ratings, one per candidate in a TRACK RECORD REVIEW block. */
  track_record: JudgeTrackRecordVerdict.array().max(200).default([]),
  /** Labeled figures, one reading per headline in a FIGURE REVIEW block. */
  figures: JudgeFigureReading.array().max(100).default([]),
  /** Parts of a registration filing the parser could not read, one per FILING REVIEW part. */
  filings: JudgeFilingReading.array().max(20).default([]),
  /** Prices read from a price list whose parser is failing, one per SKU in a PRICE REVIEW block. */
  prices: JudgePriceReading.array().max(400).default([]),
  /** Passages of a supplier's new SEC document, one entry per document in a SUPPLIER REVIEW block. */
  suppliers: JudgeSupplierReading.array().max(20).default([]),
  /** Ties read from an SEC document naming a lab site, one entry per document in a POWER SITE REVIEW block. */
  power_sites: JudgePowerSiteReading.array().max(20).default([]),
  /** Guidance read from a call document the parser found none in, one entry per document in a GUIDANCE REVIEW block. */
  guidance: JudgeGuidanceReading.array().max(10).default([]),
})
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
