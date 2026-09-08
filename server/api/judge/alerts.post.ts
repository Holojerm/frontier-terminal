// POST /api/judge/alerts — the judge routine's verdicts. Bearer
// NUXT_JUDGE_TOKEN (server/utils/judge-auth.ts). The body is gated raw, as
// text, so the schema check sees exactly what the model produced; what
// survives it is grounded against the cited change rows as D1 holds them,
// stamped, and written through the store's one chokepoint
// (server/pipeline/judge/submit.ts).
//
// 422 when the whole body failed the schema gate — that run is recorded and
// nothing else is; the 200 carries counts, including grounding rejections,
// because a partially accepted run is still a run.

import { db } from '@nuxthub/db'

import { submitJudgeRun } from '../../pipeline/judge/submit'
import { requireJudgeToken } from '../../utils/judge-auth'

/** 200 alerts of long prose fit in a tenth of this; anything bigger is not a judge output. */
const MAX_BODY_BYTES = 512 * 1024

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'judge', limit: 30, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  await requireJudgeToken(event)

  const declared = Number(getRequestHeader(event, 'content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, message: 'Body too large' })
  }
  const raw = (await readRawBody(event, 'utf8')) ?? ''
  if (raw.length > MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, message: 'Body too large' })
  }

  const report = await submitJudgeRun(db, raw, { source: 'routine' })
  if (report.gate_rejection) {
    throw createError({
      statusCode: 422,
      message: 'Judge output rejected at the schema gate',
      data: report.gate_rejection,
    })
  }
  return { schema: 1, ...report }
})
