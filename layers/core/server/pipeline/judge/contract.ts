import { z } from 'zod'

import { JUDGE_REVIEWS } from '#server/registries/judge'
import { JudgeAlert } from './alerts'

// The judge lane's whole contract: the alert half (alerts.ts) plus each review
// a domain hands the routine (server/registries/judge.ts › JUDGE_REVIEWS).
// Every object is strict. A review's key is optional, so a run with nothing
// under review prints what it always did.

/** What the model prints: the alerts, and each review's readings under its key. */
export type JudgeOutput = { alerts: JudgeAlert[] } & Record<string, unknown[]>

const reviewFields: z.ZodRawShape = Object.fromEntries(
  JUDGE_REVIEWS.map((r) => [r.key, r.reading.array().max(r.max).default([])]),
)

const JudgeOutputSchema = z.strictObject({ alerts: JudgeAlert.array(), ...reviewFields })

/**
 * The POST /api/judge/alerts body. judged_through is the cursor the routine
 * asks to advance to (the newest detected_at among the changes it was handed);
 * change_ids_seen is what it saw, kept for the run row's count.
 */
const JudgeSubmissionSchema = JudgeOutputSchema.extend({
  judged_through: AlertRow.shape.fetched_at,
  change_ids_seen: z.string().min(1).array(),
}).strict()

export type JudgeSubmission = JudgeOutput & { judged_through: string; change_ids_seen: string[] }

/** Schema gate over the raw request body, shared with the pipeline's other
 * agent lane: a body that is not JSON or carries a key the contract does not
 * name is a typed rejection, never a partial write. */
export function gateJudgeSubmission(raw: string): AgentGateResult<JudgeSubmission> {
  return parseAgentOutput(raw, JudgeSubmissionSchema) as AgentGateResult<JudgeSubmission>
}
