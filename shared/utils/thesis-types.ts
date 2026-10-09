// The thesis layer's shapes: the definitions in server/theses/ and the
// GET /api/theses payload built from them. Shared so a thesis page renders
// the same types the server computes.

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

export type SignalSpec =
  | { kind: 'measured'; signal: 'openrouter-spend-premium'; rule: MeasuredRule }
  | { kind: 'measured'; signal: 'openrouter-lab-token-share'; rule: MeasuredRule }
  | {
      kind: 'measured'
      signal: 'open-roles-in-departments'
      departments: readonly string[]
      rule: MeasuredRule
    }
  /** Rated by the judge against a rubric — lands in M2 with the rubric; unresolved until then. */
  | { kind: 'judged'; rubric: string | null }

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
  company: BigFour
  stance: 'bullish' | 'bearish'
  statement: string
  comparison_set: readonly BigFour[]
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
  kill_condition: string
  status: ClaimStatus
  /** When the claim entered its current status; null before the first evaluation. */
  status_since: string | null
  reason: string
  /** The newest reading, with the detail the signal recorded beside it. */
  latest: (ReadingPoint & { detail: unknown; source_url: string; fetched_at: string }) | null
  /** Oldest first, newest last — up to the history the rule reads. */
  series: ReadingPoint[]
}

export interface ThesisView extends Omit<ThesisDef, 'claims'> {
  claims: ClaimView[]
}

export interface ThesesData extends Stamp {
  theses: ThesisView[]
  caveat: string
}
