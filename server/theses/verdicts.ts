// The judge's half of the judged claims. GET /api/judge/pending offers each
// judged claim's candidate events as a CLAIM REVIEW block; POST
// /api/judge/alerts sends back one verdict per candidate, and this file gates
// them: the claim must be judged, the item must be one the Worker itself
// would offer for it, the verdict one the claim allows, and the rationale
// grounded in the item's record and the Worker's own facts. Only then is a
// claim_verdicts row written — once per (claim, subject).
//
// Candidates come from two places: the pending change rows (price cuts,
// incidents, disclosures), and for recipe-items claims, recipe observations
// not yet rated. `change_id` in the judge's output names either.

import { and, desc, eq, gte, inArray, notInArray } from 'drizzle-orm'
import { z } from 'zod'

import { verdictsOf, type ClaimDef, type ThesisDef } from '#shared/utils/thesis-types'

import * as tables from '../db/schema'
import { ChangeRow, contentHash } from '../pipeline/contracts'
import { effectiveClassMap } from '../pipeline/class-map'
import { groundingFailure } from '../pipeline/judge/grounding'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../pipeline/store'
import { daysBefore } from '../utils/terminal-rankings'
import { claimCandidates, recipeCandidates, type Candidate, type FlagshipMap } from './candidates'
import { THESES } from './registry'

/** Unrated recipe items offered per claim per run; the rest wait an hour. */
export const RECIPE_CANDIDATE_LIMIT = 20

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

/** A recipe-items claim's unrated observations, newest first, within its rule's window of judged_from. */
async function unratedItems(db: PipelineDb, claim: ClaimDef) {
  const spec = claim.spec
  if (spec.kind !== 'judged' || spec.review !== 'recipe-items') return []
  const rated = db
    .select({ subject: tables.claimVerdicts.subject })
    .from(tables.claimVerdicts)
    .where(eq(tables.claimVerdicts.claim_id, claim.id))
  return db
    .select()
    .from(tables.recipeObservations)
    .where(
      and(
        eq(tables.recipeObservations.recipe_id, spec.recipe),
        gte(tables.recipeObservations.date, daysBefore(spec.judged_from, spec.rule.days)),
        notInArray(tables.recipeObservations.id, rated),
      ),
    )
    .orderBy(desc(tables.recipeObservations.date))
    .limit(RECIPE_CANDIDATE_LIMIT)
}

export interface ClaimReview {
  claim_id: string
  claim: string
  rubric: string
  verdicts: readonly string[]
  candidates: { change_id: string; provider: string; facts: Record<string, unknown> }[]
}

/** The CLAIM REVIEW block: judged claims with candidates only. */
export async function claimReview(
  db: PipelineDb,
  changes: readonly ChangeRow[],
  flagships: FlagshipMap,
  theses: readonly ThesisDef[] = THESES,
): Promise<ClaimReview[]> {
  const out: ClaimReview[] = []
  for (const thesis of theses) {
    for (const claim of thesis.claims) {
      if (claim.spec.kind !== 'judged') continue
      const candidates =
        claim.spec.review === 'recipe-items'
          ? recipeCandidates(thesis, claim, await unratedItems(db, claim))
          : claimCandidates(thesis, claim, changes, flagships)
      if (candidates.length === 0) continue
      out.push({
        claim_id: claim.id,
        claim: claim.text,
        rubric: claim.spec.rubric,
        verdicts: verdictsOf(claim.spec),
        candidates: candidates.map((c) => ({
          change_id: c.item.id,
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

async function loadItems(db: PipelineDb, ids: readonly string[]) {
  const changes = new Map<string, ChangeRow>()
  const observations = new Map<string, typeof tables.recipeObservations.$inferSelect>()
  for (const group of chunk([...new Set(ids)], D1_MAX_BOUND_PARAMS)) {
    const [c, o] = await Promise.all([
      db.select().from(tables.changes).where(inArray(tables.changes.id, group)),
      db
        .select()
        .from(tables.recipeObservations)
        .where(inArray(tables.recipeObservations.id, group)),
    ])
    for (const row of c) changes.set(row.id, ChangeRow.parse(row))
    for (const row of o) observations.set(row.id, row)
  }
  return { changes, observations }
}

function gate(
  verdict: JudgeClaimVerdict,
  items: Awaited<ReturnType<typeof loadItems>>,
  flagships: FlagshipMap,
  theses: readonly ThesisDef[],
): { candidate: Candidate } | { reason: string; detail: string } {
  const thesis = theses.find((t) => t.claims.some((c) => c.id === verdict.claim_id))
  const claim = thesis?.claims.find((c) => c.id === verdict.claim_id)
  if (!thesis || !claim || claim.spec.kind !== 'judged') {
    return { reason: 'unknown-claim', detail: `no judged claim ${verdict.claim_id}` }
  }
  const change = items.changes.get(verdict.change_id)
  const observation = items.observations.get(verdict.change_id)
  if (!change && !observation) return { reason: 'unknown-change-id', detail: verdict.change_id }
  const [candidate] =
    claim.spec.review === 'recipe-items'
      ? recipeCandidates(thesis, claim, observation ? [observation] : [])
      : claimCandidates(thesis, claim, change ? [change] : [], flagships)
  if (!candidate) {
    return {
      reason: 'not-a-candidate',
      detail: `${verdict.change_id} is not offered for ${claim.id}`,
    }
  }
  const allowed = verdictsOf(claim.spec)
  if (!allowed.includes(verdict.verdict)) {
    return {
      reason: 'unknown-verdict',
      detail: `${verdict.verdict} (allowed: ${allowed.join(', ')})`,
    }
  }
  const failure = groundingFailure(
    verdict.rationale,
    `${candidate.item.corpus}\n${JSON.stringify(candidate.facts)}`,
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
  const [items, flagships] = await Promise.all([
    loadItems(
      db,
      verdicts.map((v) => v.change_id),
    ),
    flagshipMap(db),
  ])
  const judged_at = now.toISOString()
  for (const verdict of verdicts) {
    const result = gate(verdict, items, flagships, theses)
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
        change_id: c.item.id,
        provider: c.provider,
        verdict: verdict.verdict,
        rationale: verdict.rationale,
        facts: JSON.stringify(c.facts),
        detected_at: c.item.detected_at,
        judged_at,
        source_url: c.item.source_url,
        fetched_at: c.item.fetched_at,
      })
      .onConflictDoNothing()
      .returning({ id: tables.claimVerdicts.id })
    report.inserted += written.length
  }
  return report
}
