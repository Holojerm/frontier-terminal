// The judge's half of the judged claims. GET /api/judge/pending offers each
// judged claim's candidate events as a CLAIM REVIEW block; POST
// /api/judge/alerts sends back one verdict per candidate, and this file gates
// them: the claim must be judged, the change must be one the Worker itself
// would offer for it, the verdict one the claim's review allows, and the
// rationale grounded in the change record and the Worker's own facts. Only
// then is a claim_verdicts row written — once per (claim, subject).

import { inArray } from 'drizzle-orm'
import { z } from 'zod'

import { VERDICTS, type ThesisDef } from '#shared/utils/thesis-types'

import * as tables from '../db/schema'
import { ChangeRow, contentHash } from '../pipeline/contracts'
import { effectiveClassMap } from '../pipeline/class-map'
import { corpusOf, groundingFailure } from '../pipeline/judge/grounding'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../pipeline/store'
import { claimCandidates, type Candidate, type FlagshipMap } from './candidates'
import { THESES } from './registry'

export const JudgeClaimVerdict = z.strictObject({
  claim_id: z.string().min(1),
  change_id: z.string().min(1),
  verdict: z.string().min(1),
  rationale: z.string().min(1).max(600),
})
export type JudgeClaimVerdict = z.infer<typeof JudgeClaimVerdict>

export async function flagshipMap(db: PipelineDb): Promise<FlagshipMap> {
  const entries = await effectiveClassMap(db)
  return new Map(
    entries.filter((e) => e.class === 'flagship').map((e) => [e.provider, e.model_slug]),
  )
}

export interface ClaimReview {
  claim_id: string
  claim: string
  rubric: string
  verdicts: readonly string[]
  candidates: { change_id: string; provider: string; facts: Record<string, unknown> }[]
}

/** The CLAIM REVIEW block for this batch of pending changes: judged claims with candidates only. */
export function claimReview(
  changes: readonly ChangeRow[],
  flagships: FlagshipMap,
  theses: readonly ThesisDef[] = THESES,
): ClaimReview[] {
  const out: ClaimReview[] = []
  for (const thesis of theses) {
    for (const claim of thesis.claims) {
      if (claim.spec.kind !== 'judged') continue
      const candidates = claimCandidates(thesis, claim, changes, flagships)
      if (candidates.length === 0) continue
      out.push({
        claim_id: claim.id,
        claim: claim.text,
        rubric: claim.spec.rubric,
        verdicts: VERDICTS[claim.spec.review],
        candidates: candidates.map((c) => ({
          change_id: c.change.id,
          provider: c.provider,
          facts: c.facts,
        })),
      })
    }
  }
  return out
}

export interface VerdictReport {
  accepted: number
  inserted: number
  rejected: { reason: string; detail: string; claim_id: string; change_id: string }[]
}

async function loadChanges(
  db: PipelineDb,
  ids: readonly string[],
): Promise<Map<string, ChangeRow>> {
  const out = new Map<string, ChangeRow>()
  for (const group of chunk([...new Set(ids)], D1_MAX_BOUND_PARAMS)) {
    const rows = await db.select().from(tables.changes).where(inArray(tables.changes.id, group))
    for (const row of rows) out.set(row.id, ChangeRow.parse(row))
  }
  return out
}

function gate(
  verdict: JudgeClaimVerdict,
  change: ChangeRow | undefined,
  flagships: FlagshipMap,
  theses: readonly ThesisDef[],
): { candidate: Candidate } | { reason: string; detail: string } {
  const thesis = theses.find((t) => t.claims.some((c) => c.id === verdict.claim_id))
  const claim = thesis?.claims.find((c) => c.id === verdict.claim_id)
  if (!thesis || !claim || claim.spec.kind !== 'judged') {
    return { reason: 'unknown-claim', detail: `no judged claim ${verdict.claim_id}` }
  }
  if (!change) return { reason: 'unknown-change-id', detail: verdict.change_id }
  const [candidate] = claimCandidates(thesis, claim, [change], flagships)
  if (!candidate) {
    return {
      reason: 'not-a-candidate',
      detail: `${verdict.change_id} is not offered for ${claim.id}`,
    }
  }
  const allowed: readonly string[] = VERDICTS[claim.spec.review]
  if (!allowed.includes(verdict.verdict)) {
    return {
      reason: 'unknown-verdict',
      detail: `${verdict.verdict} (allowed: ${allowed.join(', ')})`,
    }
  }
  const failure = groundingFailure(
    verdict.rationale,
    `${corpusOf([change])}\n${JSON.stringify(candidate.facts)}`,
  )
  return failure ?? { candidate }
}

/** Gate, ground and store the verdicts of one judge run. */
export async function applyClaimVerdicts(
  db: PipelineDb,
  verdicts: readonly JudgeClaimVerdict[],
  now: Date,
  theses: readonly ThesisDef[] = THESES,
): Promise<VerdictReport> {
  const report: VerdictReport = { accepted: 0, inserted: 0, rejected: [] }
  if (verdicts.length === 0) return report
  const [changes, flagships] = await Promise.all([
    loadChanges(
      db,
      verdicts.map((v) => v.change_id),
    ),
    flagshipMap(db),
  ])
  const judged_at = now.toISOString()
  for (const verdict of verdicts) {
    const result = gate(verdict, changes.get(verdict.change_id), flagships, theses)
    if (!('candidate' in result)) {
      report.rejected.push({ ...result, claim_id: verdict.claim_id, change_id: verdict.change_id })
      continue
    }
    const c = result.candidate
    report.accepted++
    const written = await db
      .insert(tables.claimVerdicts)
      .values({
        id: contentHash({ claim_id: c.claim_id, subject: c.subject }),
        thesis_id: c.thesis_id,
        claim_id: c.claim_id,
        subject: c.subject,
        change_id: c.change.id,
        provider: c.provider,
        verdict: verdict.verdict,
        rationale: verdict.rationale,
        facts: JSON.stringify(c.facts),
        detected_at: c.change.detected_at,
        judged_at,
        source_url: c.change.source_url,
        fetched_at: c.change.fetched_at,
      })
      .onConflictDoNothing()
      .returning({ id: tables.claimVerdicts.id })
    report.inserted += written.length
  }
  return report
}
