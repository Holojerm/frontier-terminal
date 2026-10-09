// A judged claim's status from its stored verdicts — pure, like status.ts, so
// the evaluator and GET /api/theses read the same rules. The judge supplies
// only the verdict; every count and window here is the Worker's.

import { companyName } from '#shared/utils/companies'
import type { CompanyId } from '#shared/utils/companies'
import type { ClaimDef, Confirmation, JudgedSpec } from '#shared/utils/thesis-types'

import type { ClaimEvaluation } from './status'

export interface StoredVerdict {
  subject: string
  provider: CompanyId
  verdict: string
  facts: Record<string, unknown>
  detected_at: string
}

const DAY_MS = 86_400_000

export function confirmationOf(spec: JudgedSpec, subject: string): Confirmation | null {
  if (spec.review !== 'incidents-and-disclosures') return null
  return spec.confirmations.findLast((c) => c.subject === subject) ?? null
}

function competitiveCuts(
  spec: Extract<JudgedSpec, { review: 'flagship-price-cuts' }>,
  company: CompanyId,
  verdicts: readonly StoredVerdict[],
  now: string,
): ClaimEvaluation {
  const { min_cut, count, days } = spec.rule
  const from = new Date(Date.parse(now) - days * DAY_MS).toISOString()
  const recent = verdicts.filter((v) => v.detected_at >= from && v.verdict === 'competitive')
  const rival = recent.filter(
    (v) => v.provider !== company && Number(v.facts.cut_pct ?? 0) >= min_cut * 100,
  )
  const matched = recent.some(
    (v) => v.provider === company && rival.some((r) => r.detected_at <= v.detected_at),
  )
  const name = companyName(company)
  const listed = rival
    .map(
      (v) =>
        `${companyName(v.provider)} ${String(v.facts.model_slug)} −${String(v.facts.cut_pct)}%`,
    )
    .join(', ')
  if (rival.length === 0) {
    return {
      status: 'holding',
      reason: `No rival flagship cut of ${min_cut * 100}% or more rated competitive in the last ${days} days.`,
      reading_date: null,
    }
  }
  const status = rival.length >= count && matched ? 'broken' : 'weakening'
  return {
    status,
    reason: `${rival.length} of ${count} competitive rival cuts in ${days} days (${listed}); ${name} ${matched ? 'matched one' : 'has not matched'}.`,
    reading_date: null,
  }
}

function confirmedMaterial(
  spec: Extract<JudgedSpec, { review: 'incidents-and-disclosures' }>,
  company: CompanyId,
  verdicts: readonly StoredVerdict[],
): ClaimEvaluation {
  const material = verdicts.filter((v) => v.verdict === 'material')
  const own = material.filter((v) => v.provider === company)
  const rivals = material.length - own.length
  const vs = `${rivals} material rival event${rivals === 1 ? '' : 's'} rated`
  const decided = own.map((v) => ({ v, c: confirmationOf(spec, v.subject) }))
  const confirmed = decided.filter((d) => d.c?.decision === 'confirmed')
  const waiting = decided.filter((d) => d.c === null)
  const title = (v: StoredVerdict) => `"${String(v.facts.title)}"`
  if (confirmed.length > 0) {
    return {
      status: 'broken',
      reason: `Confirmed material: ${confirmed.map((d) => title(d.v)).join(', ')}; ${vs}.`,
      reading_date: null,
    }
  }
  if (waiting.length > 0) {
    return {
      status: 'weakening',
      reason: `Rated material, awaiting confirmation: ${waiting.map((d) => title(d.v)).join(', ')}; ${vs}.`,
      reading_date: null,
    }
  }
  return {
    status: 'holding',
    reason: `No material ${companyName(company)} event; ${vs}.`,
    reading_date: null,
  }
}

/**
 * Unresolved until a judge run has covered `judged_from`: before that, no
 * change was offered for the claim, and silence would read as holding.
 */
export function evaluateJudgedClaim(
  claim: ClaimDef,
  company: CompanyId,
  verdicts: readonly StoredVerdict[],
  judgedThrough: string | null,
  now: string,
): ClaimEvaluation {
  const spec = claim.spec
  if (spec.kind !== 'judged') throw new Error(`${claim.id} is not a judged claim`)
  if (judgedThrough === null || judgedThrough < spec.judged_from) {
    return {
      status: 'unresolved',
      reason: 'Awaiting the first judge run that covers this claim.',
      reading_date: null,
    }
  }
  return spec.review === 'flagship-price-cuts'
    ? competitiveCuts(spec, company, verdicts, now)
    : confirmedMaterial(spec, company, verdicts)
}
