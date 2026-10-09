// GET /api/judge/pending — the change rows the judge routine has not seen,
// plus the prompt to judge them with. Bearer NUXT_JUDGE_TOKEN
// (server/utils/judge-auth.ts); 404 when unset, 401 on mismatch.
//
// The prompt travels in the response so the routine judges with the prompt
// this deploy shipped, whatever commit its own checkout happens to be on —
// one prompt, versioned here. Empty `changes` with no cell in
// `class_map_review` is the common case and the routine's signal to stop.
// `class_map_review` lists the price-matrix cells whose vendor sentence left
// the page, with that page's text to re-map them from
// (server/pipeline/judge/class-map.ts). `claim_review` lists, per judged
// thesis claim, the pending changes it offers for a verdict
// (server/theses/verdicts.ts): events among `changes`, and recipe items
// (a changelog entry, say) not yet rated, so it can be non-empty when
// `changes` is empty.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import judgePrompt from 'raw:../../pipeline/judge/judge-explain.prompt.md'

import { blobRawReader, classMapReview } from '../../pipeline/judge/class-map'
import { JUDGE_CHANGE_LIMIT, pendingChanges } from '../../pipeline/judge/pending'
import { claimReview, flagshipMap } from '../../theses/verdicts'
import { requireJudgeToken } from '../../utils/judge-auth'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'judge', limit: 30, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  await requireJudgeToken(event)

  const [{ changes, total_pending, since }, class_map_review, flagships] = await Promise.all([
    pendingChanges(db, JUDGE_CHANGE_LIMIT),
    classMapReview(db, blobRawReader(blob)),
    flagshipMap(db),
  ])
  return {
    schema: 1,
    changes,
    total_pending,
    since,
    limit: JUDGE_CHANGE_LIMIT,
    class_map_review,
    claim_review: await claimReview(db, changes, flagships),
    prompt: judgePrompt,
  }
})
