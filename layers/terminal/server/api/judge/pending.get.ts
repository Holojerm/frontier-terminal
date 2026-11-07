// GET /api/judge/pending — the change rows the judge routine has not seen,
// plus the prompt to judge them with. Bearer NUXT_JUDGE_TOKEN
// (layers/terminal/server/utils/judge-auth.ts); 404 when unset, 401 on mismatch.
//
// The prompt travels in the response so the routine judges with the prompt
// this deploy shipped, whatever commit its own checkout happens to be on —
// one prompt, versioned here. `changes` are the oldest pending first, and
// `through` is the cursor POST /api/judge/alerts accepts for them. Empty `changes` with no cell in
// `class_map_review` is the common case and the routine's signal to stop.
// `class_map_review` lists the price-matrix cells whose vendor sentence left
// the page, with that page's text to re-map them from
// (layers/terminal/server/pipeline/judge/class-map.ts). `claim_review` lists, per judged
// thesis claim, the pending changes it offers for a verdict
// (layers/terminal/server/theses/verdicts.ts): events among `changes`, and recipe items
// (a changelog entry, say) not yet rated, so it can be non-empty when
// `changes` is empty. `hiring` gives, per lab with job changes pending, the
// board and department sizes and which moves clear the materiality floor
// that POST /api/judge/alerts enforces (layers/terminal/server/pipeline/hiring-floor.ts).
// `track_record_review` lists, per material alert, the press articles and
// newsroom posts found around it that still need a same-event rating
// (layers/terminal/server/pipeline/track-record/review.ts); like
// `claim_review`, it can be non-empty when `changes` is empty.
// `figure_review` lists press headlines that state a lab's revenue,
// valuation or funding and are not yet read
// (layers/terminal/server/pipeline/reported/review.ts); it too can be
// non-empty when `changes` is empty.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import judgePrompt from 'raw:../../pipeline/judge/judge-explain.prompt.md'
import sourcesYaml from 'raw:~~/sources.yaml'

import { hiringBoards } from '../../pipeline/hiring-floor'
import { blobRawReader, classMapReview } from '../../pipeline/judge/class-map'
import { JUDGE_CHANGE_LIMIT, pendingChanges } from '../../pipeline/judge/pending'
import { figureReview } from '../../pipeline/reported/review'
import { trackRecordReview } from '../../pipeline/track-record/review'
import { claimReview, flagshipMap } from '../../theses/verdicts'
import { requireJudgeToken } from '../../utils/judge-auth'
import { parseDepartmentClusters } from '../../utils/terminal-clusters'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'judge', limit: 30, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  await requireJudgeToken(event)

  const [
    { changes, total_pending, since, through },
    class_map_review,
    flagships,
    track_record_review,
    figure_review,
  ] = await Promise.all([
    pendingChanges(db, JUDGE_CHANGE_LIMIT),
    classMapReview(db, blobRawReader(blob)),
    flagshipMap(db),
    trackRecordReview(db),
    figureReview(db),
  ])
  const [claim_review, hiring] = await Promise.all([
    claimReview(db, changes, flagships),
    hiringBoards(db, changes, parseDepartmentClusters(sourcesYaml)),
  ])
  return {
    schema: 1,
    changes,
    total_pending,
    since,
    // The judged_through to send back: the newest detected_at among `changes`.
    through,
    limit: JUDGE_CHANGE_LIMIT,
    hiring,
    class_map_review,
    claim_review,
    track_record_review,
    figure_review,
    prompt: judgePrompt,
  }
})
