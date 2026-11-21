// What the judge routine reads beside the changes, and what gates its alerts:
// the app's composition root for the judge. The runner is core's
// (layers/core/server/pipeline/judge/: submit.ts, contract.ts and the
// /api/judge routes); each domain defines its review beside the code that
// stores what the routine reads (a JudgeReview) and gets one line here.
//
// JUDGE_REVIEWS is in the order the body's keys, the run report and the
// pending payload's offers list them. JUDGE_CONTEXT is the pending payload's
// other blocks, before the offers. JUDGE_ALERT_SCREEN runs on the grounded
// alerts before they are stored.

import type {
  JudgeAlertScreen,
  JudgeContextEntry,
  JudgeReview,
} from '#layers/core/server/pipeline/judge/review'
import { incidentCounts } from '#layers/core/server/pipeline/judge/pending'
import { FILING_REVIEW } from '#layers/companies/server/pipeline/judge/filing-review'
import { GUIDANCE_REVIEW } from '#layers/companies/server/calls/review'
import { SUPPLIER_REVIEW } from '#layers/companies/server/suppliers/review'
import { POWER_SITE_REVIEW } from '#layers/compute/server/power/review'
import { CLASS_MAP_REVIEW } from '#layers/pricing/server/pipeline/judge/class-map'
import { PRICE_REVIEW } from '#layers/pricing/server/pipeline/judge/price-review'
import { hiringBoards } from '#layers/talent/server/pipeline/hiring-floor'
import { parseDepartmentClusters } from '#layers/talent/server/utils/terminal-clusters'
import {
  screenJudgeAlerts,
  type ScreenOptions,
} from '#layers/terminal/server/pipeline/judge/screen'
import { stillListedRemovals } from '#layers/core/server/pipeline/judge/still-listed'
import { FIGURE_REVIEW } from '#layers/press/server/pipeline/reported/review'
import { TRACK_RECORD_REVIEW } from '#layers/press/server/pipeline/track-record/review'
import { CLAIM_REVIEW } from '#layers/theses/server/theses/verdicts'

export const JUDGE_REVIEWS: readonly JudgeReview[] = [
  CLASS_MAP_REVIEW,
  CLAIM_REVIEW,
  TRACK_RECORD_REVIEW,
  FIGURE_REVIEW,
  FILING_REVIEW,
  PRICE_REVIEW,
  SUPPLIER_REVIEW,
  POWER_SITE_REVIEW,
  GUIDANCE_REVIEW,
]

export const JUDGE_CONTEXT: readonly JudgeContextEntry[] = [
  // Per lab with job changes pending, the board and department sizes and which
  // moves clear the hiring floor the screen enforces.
  {
    key: 'hiring',
    read: ({ db, changes, sourcesYaml }) =>
      hiringBoards(db, changes, parseDepartmentClusters(sourcesYaml)),
  },
  { key: 'incidents', read: ({ db, changes }) => incidentCounts(db, changes) },
  // Per model removal among the changes, the pages of the same lab that still list it.
  { key: 'still_listed', read: ({ db, changes }) => stillListedRemovals(db, changes) },
]

/** What submitJudgeRun accepts for the screen beside its own options. */
export type JudgeScreenOptions = ScreenOptions

export const JUDGE_ALERT_SCREEN: JudgeAlertScreen<JudgeScreenOptions> = screenJudgeAlerts
