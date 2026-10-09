// Which change rows a judged claim offers the judge, and every number about
// them. Pure: the pending route and the submit gate run the same selection,
// so a verdict can only land on a change the Worker itself would have offered,
// and the judge is never the source of a cut's size or an outage's length.

import type { CompanyId } from '#shared/utils/companies'
import type { ClaimDef, JudgedSpec, ThesisDef } from '#shared/utils/thesis-types'

import type { ChangeRow } from '../pipeline/contracts'

export interface Candidate {
  thesis_id: string
  claim_id: string
  /** What a verdict is about: the change for a price cut, the incident or disclosure entity_key otherwise. */
  subject: string
  change: ChangeRow
  provider: CompanyId
  facts: Record<string, unknown>
}

/** provider → the model slug its vendor recommends as the flagship today. */
export type FlagshipMap = ReadonlyMap<string, string>

const parse = (json: string | null): Record<string, unknown> | null =>
  json === null ? null : (JSON.parse(json) as Record<string, unknown>)

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Fractional fall from `before` to `after`, or null when it did not fall. */
function fall(before: unknown, after: unknown): number | null {
  const b = num(before)
  const a = num(after)
  return b !== null && a !== null && b > 0 && a < b ? (b - a) / b : null
}

function priceCut(change: ChangeRow, flagships: FlagshipMap): Record<string, unknown> | null {
  if (change.entity_type !== 'model' || change.change_type !== 'modified') return null
  const before = parse(change.before_json)
  const after = parse(change.after_json)
  if (!before || !after) return null
  const tier = after.tier ?? null
  if (tier !== null && tier !== 'standard') return null
  if (flagships.get(change.provider) !== after.model_slug) return null
  const input = fall(before.input_per_mtok, after.input_per_mtok)
  const output = fall(before.output_per_mtok, after.output_per_mtok)
  if (input === null && output === null) return null
  // The larger of the two falls: a cut on either list price is a cut.
  const cut = Math.max(input ?? 0, output ?? 0)
  return {
    model_slug: after.model_slug,
    input_before: before.input_per_mtok ?? null,
    input_after: after.input_per_mtok ?? null,
    output_before: before.output_per_mtok ?? null,
    output_after: after.output_per_mtok ?? null,
    cut_pct: Math.round(cut * 100),
  }
}

type IncidentRule = Extract<JudgedSpec, { review: 'incidents-and-disclosures' }>['rule']

function incidentOrDisclosure(
  change: ChangeRow,
  rule: IncidentRule,
): Record<string, unknown> | null {
  const row = parse(change.after_json)
  if (!row) return null
  if (change.entity_type === 'disclosure') {
    return change.change_type === 'added'
      ? { kind: row.kind ?? null, title: row.title ?? null }
      : null
  }
  if (change.entity_type !== 'incident' || change.change_type === 'removed') return null
  if (typeof row.impact !== 'string' || !rule.impacts.includes(row.impact)) return null
  const start = typeof row.started_at === 'string' ? Date.parse(row.started_at) : NaN
  const endText = typeof row.resolved_at === 'string' ? row.resolved_at : change.fetched_at
  const hours = (Date.parse(endText) - start) / 3_600_000
  if (!Number.isFinite(hours) || hours < rule.min_hours) return null
  return {
    title: row.title ?? null,
    impact: row.impact,
    started_at: row.started_at,
    resolved_at: row.resolved_at ?? null,
    hours: Math.round(hours * 10) / 10,
  }
}

/** The candidates one judged claim takes from `changes`. */
export function claimCandidates(
  thesis: ThesisDef,
  claim: ClaimDef,
  changes: readonly ChangeRow[],
  flagships: FlagshipMap,
): Candidate[] {
  const spec = claim.spec
  if (spec.kind !== 'judged') return []
  const covered = new Set<string>([thesis.company, ...thesis.comparison_set])
  const out: Candidate[] = []
  for (const change of changes) {
    if (!covered.has(change.provider) || change.detected_at < spec.judged_from) continue
    const facts =
      spec.review === 'flagship-price-cuts'
        ? priceCut(change, flagships)
        : incidentOrDisclosure(change, spec.rule)
    if (!facts) continue
    out.push({
      thesis_id: thesis.id,
      claim_id: claim.id,
      subject: spec.review === 'flagship-price-cuts' ? change.id : change.entity_key,
      change,
      provider: change.provider as CompanyId,
      facts,
    })
  }
  return out
}
