// The weekly thesis digest: every claim's status, what moved in the last
// seven days, what the judge rated, and what awaits your confirmation. Pure —
// it takes the GET /api/theses payload and the week's status-change rows —
// so the wording is tested without a database or a mail binding. Sent every
// week, quiet weeks included: a digest that stops arriving is the signal
// that something broke.

import { companyName } from '#shared/utils/companies'
import type { ClaimView, ThesesData, VerdictView } from '#shared/utils/thesis-types'

import type { ClaimStatusChange } from '../db/schema'
import { renderEmail, type RenderedEmail } from '../utils/render-email'
import { formatOpsTime } from '../utils/ops-digest'
import { daysBefore } from '../utils/terminal-rankings'
import { THESES } from './registry'
import { presentation } from './signals'

export const DIGEST_DAYS = 7

const TONE = { broken: 'bad', weakening: 'warn', holding: 'good', unresolved: 'idle' } as const

/** A reading a week before the newest, and the newest: `1.81× → 1.87×`. */
function weekLine(claim: ClaimView): string | null {
  const def = THESES.flatMap((t) => t.claims).find((c) => c.id === claim.id)
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
  now: Date
  appName: string
  appUrl: string
}

export function buildThesisDigest(input: DigestInput): RenderedEmail & { subject: string } {
  const since = new Date(input.now.getTime() - DIGEST_DAYS * 86_400_000).toISOString()
  let moved = 0
  let rated = 0
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
    const verdicts = thesis.claims.flatMap((claim) =>
      claim.verdicts
        .filter((v) => v.judged_at >= since)
        .map((v) => ({
          n: claim.n,
          provider: companyName(v.provider),
          verdict: v.verdict,
          event: eventLabel(v),
          url: v.source_url,
          rationale: v.rationale,
        })),
    )
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
    quiet: moved === 0 && rated === 0,
    theses,
  })
  return { subject: `${input.appName} theses · ${summary}`, ...rendered }
}
