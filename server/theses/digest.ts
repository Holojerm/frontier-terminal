// The weekly thesis digest: every claim's status, what moved in the last
// seven days, what the judge rated, which recipes failed, and what awaits
// your confirmation. It builds understanding, not trades, so evidence against
// the thesis leads: weaker claims first, then verdicts that count toward a
// kill condition. Pure — it takes the GET /api/theses payload and the week's
// rows — so the wording is tested without a database or a mail binding. Sent
// every week, quiet weeks included: a digest that stops arriving is the
// signal that something broke.

import { companyName } from '#shared/utils/companies'
import type {
  ClaimDef,
  ClaimStatus,
  ClaimView,
  ThesesData,
  VerdictView,
} from '#shared/utils/thesis-types'
import type { CompanyId } from '#shared/utils/companies'

import type { ClaimStatusChange, RecipeRun } from '../db/schema'
import { renderEmail, type RenderedEmail } from '../utils/render-email'
import { formatOpsTime } from '../utils/ops-digest'
import { daysBefore } from '../utils/terminal-rankings'
import { THESES } from './registry'
import { presentation } from './signals'

export const DIGEST_DAYS = 7

const TONE = { broken: 'bad', weakening: 'warn', holding: 'good', unresolved: 'idle' } as const

/** Weakest first: an unresolved claim sits above holding so a gap never reads as support. */
const RANK: Record<ClaimStatus, number> = { broken: 0, weakening: 1, unresolved: 2, holding: 3 }

const defOf = (id: string): ClaimDef | undefined =>
  THESES.flatMap((t) => t.claims).find((c) => c.id === id)

/** Whether a verdict moves its claim toward the kill condition. */
export function countsAgainst(def: ClaimDef, company: CompanyId, v: VerdictView): boolean {
  if (def.spec.kind !== 'judged') return false
  switch (def.spec.review) {
    case 'flagship-price-cuts':
      return v.verdict === 'competitive' && v.provider !== company
    case 'incidents-and-disclosures':
      return v.verdict === 'material' && v.provider === company
    case 'recipe-items':
      return false
  }
}

/** The recipes a claim reads, its comparison set's included. */
export function recipesOf(def: ClaimDef): string[] {
  const spec = def.spec
  if (spec.kind === 'judged') return spec.review === 'recipe-items' ? [spec.recipe] : []
  if (spec.signal === 'recipe-yoy-growth') return [spec.recipe, ...spec.compare_recipes]
  if (spec.signal === 'recipe-trailing-sum' || spec.signal === 'recipe-sum-of-keys') {
    return [spec.recipe]
  }
  return []
}

/** A reading a week before the newest, and the newest: `1.81× → 1.87×`. */
function weekLine(claim: ClaimView): string | null {
  const def = defOf(claim.id)
  const newest = claim.series.at(-1)
  if (!def || def.spec.kind !== 'measured' || !newest) return null
  const target = daysBefore(newest.date, DIGEST_DAYS)
  const before = claim.series.findLast((p) => p.date <= target)
  if (!before) return null
  const { fmt } = presentation(def)
  return `${fmt(before.value)} → ${fmt(newest.value)}`
}

/** One line naming the event a verdict is about, from the Worker's facts. */
export function eventLabel(v: VerdictView): string {
  const f = v.facts
  if (typeof f.cut_pct === 'number') return `${String(f.model_slug)} −${f.cut_pct}%`
  if (typeof f.hours === 'number') return `"${String(f.title)}" (${f.hours}h, ${String(f.impact)})`
  return `"${String(f.title)}"`
}

export interface DigestInput {
  data: ThesesData
  /** claim_status_changes rows from the last DIGEST_DAYS days. */
  changes: readonly ClaimStatusChange[]
  /** recipe_runs rows that failed in the last DIGEST_DAYS days. */
  failedRuns: readonly Pick<RecipeRun, 'recipe_id' | 'started_at' | 'detail'>[]
  now: Date
  appName: string
  appUrl: string
}

export function buildThesisDigest(input: DigestInput): RenderedEmail & { subject: string } {
  const since = new Date(input.now.getTime() - DIGEST_DAYS * 86_400_000).toISOString()
  let moved = 0
  let rated = 0
  let failed = 0
  const theses = input.data.theses.map((thesis) => {
    const claims = thesis.claims.map((claim) => {
      const week = input.changes
        .filter((c) => c.claim_id === claim.id && c.changed_at >= since)
        .sort((a, b) => (a.changed_at < b.changed_at ? -1 : 1))
      const from = week[0]?.previous_status ?? null
      const movedFrom = from !== null && from !== claim.status ? from : null
      if (movedFrom) moved++
      return {
        n: claim.n,
        text: claim.text,
        status: claim.status,
        [TONE[claim.status]]: true,
        moved: movedFrom,
        reason: claim.reason,
        week: weekLine(claim),
      }
    })
    claims.sort((a, b) => RANK[a.status] - RANK[b.status] || +!a.moved - +!b.moved || a.n - b.n)
    const verdicts = thesis.claims
      .flatMap((claim) => {
        const def = defOf(claim.id)
        return claim.verdicts
          .filter((v) => v.judged_at >= since)
          .map((v) => ({
            n: claim.n,
            against: def ? countsAgainst(def, thesis.company, v) : false,
            provider: companyName(v.provider),
            verdict: v.verdict,
            event: eventLabel(v),
            url: v.source_url,
            rationale: v.rationale,
          }))
      })
      .sort((a, b) => +b.against - +a.against || a.n - b.n)
    const gaps = thesis.claims.flatMap((claim) => {
      const def = defOf(claim.id)
      return (def ? recipesOf(def) : []).flatMap((recipe) => {
        const runs = input.failedRuns.filter((r) => r.recipe_id === recipe && r.started_at >= since)
        if (runs.length === 0) return []
        const last = runs.reduce((a, b) => (a.started_at > b.started_at ? a : b))
        return [{ n: claim.n, recipe, runs: runs.length, detail: last.detail ?? 'no detail' }]
      })
    })
    failed += gaps.length
    rated += verdicts.length
    const awaiting = thesis.claims.flatMap((claim) =>
      claim.verdicts
        .filter(
          (v) =>
            v.verdict === 'material' && v.provider === thesis.company && v.confirmation === null,
        )
        .map((v) => ({ n: claim.n, event: eventLabel(v), subject: v.subject })),
    )
    const counts = (['holding', 'weakening', 'broken', 'unresolved'] as const)
      .map((s) => [s, thesis.claims.filter((c) => c.status === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ')
    return {
      name: `${companyName(thesis.company)} (${thesis.stance})`,
      statement: thesis.statement,
      counts,
      claims,
      verdicts,
      gaps,
      awaiting,
    }
  })

  const head = theses.map((t) => `${t.name.split(' ')[0]}: ${t.counts}`).join('; ')
  const tail = moved > 0 ? ` · ${moved} claim${moved === 1 ? '' : 's'} moved` : ''
  const summary = `${head}${tail}`
  const rendered = renderEmail('thesis-digest', {
    appName: input.appName,
    appUrl: input.appUrl,
    summary,
    generated: formatOpsTime(input.now),
    thesesUrl: `${input.appUrl}/api/theses`,
    quiet: moved === 0 && rated === 0 && failed === 0,
    theses,
  })
  return { subject: `${input.appName} theses · ${summary}`, ...rendered }
}
