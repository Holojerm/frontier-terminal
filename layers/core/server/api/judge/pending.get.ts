// GET /api/judge/pending: the change rows the judge routine has not seen, plus
// the prompt to judge them with. Bearer NUXT_JUDGE_TOKEN
// (layers/core/server/utils/judge-auth.ts); 404 when unset, 401 on mismatch.
//
// The prompt travels in the response so the routine judges with the prompt this
// deploy shipped, whatever commit its checkout is on. Every block after `limit`
// is a registry entry (server/registries/judge.ts): JUDGE_CONTEXT's, then each
// JUDGE_REVIEWS offer, each documented in its own module. `changes` are oldest
// first, and `through` is the cursor POST /api/judge/alerts accepts for them.
// Empty `changes` with no cell in `class_map_review` is the common case and the
// routine's signal to stop; most review blocks can be non-empty without changes.

import judgePrompt from 'raw:../../pipeline/judge/judge-explain.prompt.md'
import sourcesYaml from 'raw:~~/sources.yaml'

import { JUDGE_CONTEXT, JUDGE_REVIEWS } from '#server/registries/judge'
import { JUDGE_CHANGE_LIMIT, pendingChanges } from '../../pipeline/judge/pending'
import type { JudgeContextEntry } from '../../pipeline/judge/review'

/** The context blocks, then every review's offer, in registry order. */
const BLOCKS: readonly JudgeContextEntry[] = [
  ...JUDGE_CONTEXT,
  ...JUDGE_REVIEWS.flatMap((r) => (r.offer ? [r.offer] : [])),
]

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'judge', limit: 30, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  await requireJudgeToken(event)

  const { changes, total_pending, since, through } = await pendingChanges(db, JUDGE_CHANGE_LIMIT)
  const ctx = { db, readRaw: blobRawReader(blob), changes, sourcesYaml, now: new Date() }
  const blocks = await Promise.all(BLOCKS.map((b) => b.read(ctx)))
  return {
    schema: 1,
    changes,
    total_pending,
    since,
    // The judged_through to send back: the newest detected_at among `changes`.
    through,
    limit: JUDGE_CHANGE_LIMIT,
    ...Object.fromEntries(BLOCKS.map((b, i) => [b.key, blocks[i]])),
    prompt: judgePrompt,
  }
})
