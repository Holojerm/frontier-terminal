// GET /api/judge/pending — the change rows the judge routine has not seen,
// plus the prompt to judge them with. Bearer NUXT_JUDGE_TOKEN
// (server/utils/judge-auth.ts); 404 when unset, 401 on mismatch.
//
// The prompt travels in the response so the routine judges with the prompt
// this deploy shipped, whatever commit its own checkout happens to be on —
// one prompt, versioned here. Empty `changes` is the common case and the
// routine's signal to stop.

import { db } from '@nuxthub/db'

import judgePrompt from 'raw:../../pipeline/judge/judge-explain.prompt.md'

import { JUDGE_CHANGE_LIMIT, pendingChanges } from '../../pipeline/judge/pending'
import { requireJudgeToken } from '../../utils/judge-auth'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'judge', limit: 30, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  await requireJudgeToken(event)

  const { changes, total_pending, since } = await pendingChanges(db, JUDGE_CHANGE_LIMIT)
  return {
    schema: 1,
    changes,
    total_pending,
    since,
    limit: JUDGE_CHANGE_LIMIT,
    prompt: judgePrompt,
  }
})
