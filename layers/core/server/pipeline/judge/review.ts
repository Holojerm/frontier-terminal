import type { z } from 'zod'

import type { ChangeRow } from '../../utils/contracts'
import type { RawReader } from '../../utils/pipeline-raw'
import type { PipelineDb } from '../../utils/pipeline-store'
import type { JudgeAlert } from './alerts'
import type { AlertGroundingRejection } from './grounding'

// The judge runner's extension points (submit.ts, contract.ts and the
// /api/judge routes). A domain that hands the routine something to read beside
// the changes defines a JudgeReview: the key its readings travel under, their
// schema, how they are stored, and what GET /api/judge/pending offers for them.
// A JudgeContextEntry adds a block to the pending payload that is not a review
// (the hiring boards, the incident counts). The JudgeAlertScreen is what runs
// on the grounded alerts before they are stored. server/registries/judge.ts
// lists all three; core names no domain.

/** What a review's offer reads: the store, the stored pages, and the changes on offer. */
export interface JudgeOfferContext {
  db: PipelineDb
  readRaw: RawReader
  changes: readonly ChangeRow[]
  sourcesYaml: string
  now: Date
}

/** What a review's readings are stored with. */
export interface JudgeApplyContext {
  db: PipelineDb
  readRaw: RawReader
  now: Date
}

/** A review's run report: at least what it rejected, each with why. */
export interface JudgeReviewReport {
  rejected: readonly { reason: string; detail: string }[]
}

export interface JudgeReview {
  /** The key the routine sends its readings under, and the run report's. */
  key: string
  /** One reading, and the most one body may carry. */
  reading: z.ZodType
  max: number
  /** The report of a run whose body was rejected whole. */
  empty: object
  /**
   * Stores the readings that pass the domain's own gate, after the alerts.
   * Absent for a review the alert screen applies (its report comes back in
   * JudgeScreenResult.reports under the same key).
   */
  apply?: (ctx: JudgeApplyContext, readings: readonly unknown[]) => Promise<JudgeReviewReport>
  /** The ops event a rejection raises: `<n> <noun> rejected; first: … (<first[subject]>)`. */
  rejected?: { noun: string; subject: string }
  /** What GET /api/judge/pending offers for this review, under `key`. */
  offer?: { key: string; read: (ctx: JudgeOfferContext) => Promise<unknown> }
}

/** A typed review, erased to the registry's shape. */
export function judgeReview<T extends z.ZodType, R extends JudgeReviewReport>(review: {
  key: string
  reading: T
  max: number
  empty: R
  apply?: (ctx: JudgeApplyContext, readings: readonly z.infer<T>[]) => Promise<R>
  rejected?: { noun: string; subject: keyof R['rejected'][number] & string }
  offer?: JudgeReview['offer']
}): JudgeReview {
  return review as JudgeReview
}

/** The ops-event detail for a review's rejections, or null when it rejected none. */
export function reviewRejectionDetail(
  review: JudgeReview,
  report: JudgeReviewReport,
): string | null {
  if (!review.rejected || report.rejected.length === 0) return null
  const first = report.rejected[0] as { reason: string; detail: string } & Record<string, unknown>
  return `${report.rejected.length} ${review.rejected.noun} rejected; first: ${first.reason} — ${first.detail} (${String(first[review.rejected.subject])})`
}

/** A block of the pending payload that is not a review's offer. */
export interface JudgeContextEntry {
  key: string
  read: (ctx: JudgeOfferContext) => Promise<unknown>
}

/** An alert stored below the severity the routine sent, and why. */
export interface JudgeClamp {
  headline: string
  from: 'notable' | 'critical'
  to: 'info' | 'notable'
  detail: string
}

export interface JudgeScreenInput<Options> {
  db: PipelineDb
  readRaw: RawReader
  now: Date
  sourcesYaml?: string
  options: Options
  /** The whole gated body, for the reviews the screen applies. */
  body: Readonly<Record<string, unknown>>
  /** The alerts that passed the cursor window and grounding. */
  alerts: readonly JudgeAlert[]
  /** The change rows they cite, as D1 holds them. */
  cited: readonly ChangeRow[]
}

export interface JudgeScreenResult {
  /** The alerts the screen did not reject: the run's accepted count. */
  accepted: readonly JudgeAlert[]
  /** Those alerts, with any severity the screen lowered: what is stored. */
  alerts: JudgeAlert[]
  rejected: AlertGroundingRejection[]
  clamped: JudgeClamp[]
  /** The reports of the reviews the screen applied, by key. */
  reports: Record<string, unknown>
}

/** What runs on the grounded alerts before they are stored (server/registries/judge.ts). */
export type JudgeAlertScreen<Options> = (
  input: JudgeScreenInput<Options>,
) => Promise<JudgeScreenResult>
