// The thesis layer's shapes: the definitions in server/theses/ and the
// GET /api/theses payload built from them. Shared so a thesis page renders
// the same types the server computes.

import type { CompanyId } from './companies'
import type { BigFour, Stamp } from './terminal-types'

export type ClaimStatus = 'holding' | 'weakening' | 'broken' | 'unresolved'

/** A claim checked against a number the pipeline produces. Each rule is
 * evaluated over weekly checkpoints: the newest reading, then the readings
 * 7, 14, 21… days before it. */
export type MeasuredRule =
  /** Broken when the value sits below `floor` (or below the comparator's own
   * value) at `weeks` consecutive checkpoints; weakening while that run is shorter. */
  | { rule: 'sustained-floor'; floor: number; comparator: BigFour | null; weeks: number }
  /** Broken when the value sits more than `margin` below the mean of the
   * previous `weeks` checkpoints; weakening past half the margin. Unresolved
   * with fewer than `min_weeks` checkpoints of history. */
  | { rule: 'below-trailing-average'; margin: number; weeks: number; min_weeks: number }
  /** Broken when the value has fallen `drop` or more from its high over the
   * last `days`; weakening past half the drop. Unresolved with fewer than
   * `min_days` of history. */
  | { rule: 'drawdown-from-high'; drop: number; days: number; min_days: number }
  /** For readings that are periods (quarters), not days: broken when the
   * newest `periods` readings all sit below `floor`; weakening while fewer do. */
  | { rule: 'below-floor-periods'; floor: number; periods: number }

/** How a reading's value prints. */
export type ValueFormat = 'ratio' | 'percent' | 'count' | 'usd'

export type SignalSpec =
  | { kind: 'measured'; signal: 'openrouter-spend-premium'; rule: MeasuredRule }
  | { kind: 'measured'; signal: 'openrouter-lab-token-share'; rule: MeasuredRule }
  | {
      kind: 'measured'
      signal: 'open-roles-in-departments'
      departments: readonly string[]
      rule: MeasuredRule
    }
  /** Recipe signals (server/theses/recipes/): computed from recipe_observations. */
  | {
      kind: 'measured'
      /** Each period's value against the same period a year earlier, as a growth rate. */
      signal: 'recipe-yoy-growth'
      recipe: string
      key: string
      /** Recipes whose same-period growth is shown beside it (the comparison set). */
      compare_recipes: readonly string[]
      format: ValueFormat
      rule: MeasuredRule
    }
  | {
      kind: 'measured'
      /** The sum of a daily series over the trailing `days`, per day. */
      signal: 'recipe-trailing-sum'
      recipe: string
      key: string
      days: number
      format: ValueFormat
      rule: MeasuredRule
    }
  | {
      kind: 'measured'
      /** The sum of several keys' values on each date (e.g. departments). */
      signal: 'recipe-sum-of-keys'
      recipe: string
      keys: readonly string[]
      format: ValueFormat
      rule: MeasuredRule
    }
  | JudgedSpec

/** A judged event's verdict, by the review that offered it (recipe-items claims declare their own). */
export const VERDICTS = {
  'flagship-price-cuts': ['competitive', 'generational'],
  'incidents-and-disclosures': ['material', 'not-material'],
} as const

/** The verdicts a judged claim accepts. */
export const verdictsOf = (spec: JudgedSpec): readonly string[] =>
  spec.review === 'recipe-items' ? spec.verdicts : VERDICTS[spec.review]

/** Your ruling on a material verdict — committed to the thesis, never set by the judge. */
export interface Confirmation {
  /** The verdict's subject: the incident or disclosure entity_key. */
  subject: string
  decision: 'confirmed' | 'rejected'
  on: string
  note: string
}

/**
 * A claim the judge rates. The Worker picks the candidate events and computes
 * every number about them (a cut's size, an outage's hours); the judge only
 * chooses a verdict per candidate and says why, grounded in the records.
 */
export type JudgedSpec = {
  kind: 'judged'
  rubric: string
  /** Changes detected before this date were never offered for this claim. */
  judged_from: string
} & (
  | {
      review: 'flagship-price-cuts'
      /** Broken when `count` rival cuts of `min_cut` or more are rated competitive
       * within `days` and the company makes a competitive cut after one of them;
       * weakening from the first such rival cut. */
      rule: { rule: 'competitive-cuts'; min_cut: number; count: number; days: number }
    }
  | {
      review: 'incidents-and-disclosures'
      /** Candidates: incidents at one of `impacts` lasting `min_hours` or more, and
       * every new disclosure. Broken by a material verdict on the company that is
       * confirmed; weakening while one awaits confirmation. */
      rule: { rule: 'confirmed-material'; impacts: readonly string[]; min_hours: number }
      confirmations: readonly Confirmation[]
    }
  | {
      /** Every observation of `recipe` is a candidate (a changelog entry, say), rated once. */
      review: 'recipe-items'
      recipe: string
      verdicts: readonly string[]
      /** Broken when no item was rated `verdict` in the last `days` (once that much has
       * been rated); weakening when none was in the last half of them. */
      rule: { rule: 'recent-verdict'; verdict: string; days: number }
    }
)

export interface ClaimDef {
  /** Stable across revisions: readings and status changes are keyed by it. */
  id: string
  n: number
  text: string
  /** How the signal is described on the thesis page. */
  signal_label: string
  kill_condition: string
  spec: SignalSpec
}

export interface ThesisDef {
  id: string
  company: CompanyId
  stance: 'bullish' | 'bearish'
  statement: string
  comparison_set: readonly CompanyId[]
  horizon: string
  position: 'long' | 'short' | 'none'
  opened: string
  /** The thesis's journal page in the repo. */
  doc_path: string
  claims: readonly ClaimDef[]
}

export interface ReadingPoint {
  date: string
  value: number
}

export interface ClaimView {
  id: string
  n: number
  text: string
  signal_label: string
  signal_kind: 'measured' | 'judged'
  /** How a measured claim's values print; null for a judged claim. */
  format: ValueFormat | null
  kill_condition: string
  status: ClaimStatus
  /** When the claim entered its current status; null before the first evaluation. */
  status_since: string | null
  reason: string
  /** The newest reading, with the detail the signal recorded beside it. */
  latest: (ReadingPoint & { detail: unknown; source_url: string; fetched_at: string }) | null
  /** Oldest first, newest last — up to the history the rule reads. */
  series: ReadingPoint[]
  /** Judged claims: every verdict the rule reads, newest first. */
  verdicts: VerdictView[]
}

export interface VerdictView {
  subject: string
  change_id: string
  provider: CompanyId
  verdict: string
  rationale: string
  /** What the Worker computed about the event — the judge never supplies a number. */
  facts: Record<string, unknown>
  detected_at: string
  judged_at: string
  confirmation: Confirmation['decision'] | null
  source_url: string
  fetched_at: string
}

export interface ThesisView extends Omit<ThesisDef, 'claims'> {
  company_name: string
  ticker: string | null
  comparison_names: string[]
  claims: ClaimView[]
}

export interface ThesesData extends Stamp {
  theses: ThesisView[]
  caveat: string
}
