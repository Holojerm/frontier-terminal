// POST /api/judge/alerts — the judge routine's verdicts. Bearer
// NUXT_JUDGE_TOKEN (layers/core/server/utils/judge-auth.ts). The body is gated raw, as
// text, so the schema check sees exactly what the model produced; what
// survives it is grounded against the cited change rows as D1 holds them,
// stamped, and written through the store's one chokepoint
// (layers/core/server/pipeline/judge/submit.ts). Any class_map re-mapping is checked
// against the vendor page as R2 holds it (layers/pricing/server/pipeline/judge/class-map.ts).
//
// 422 when the whole body failed the schema gate or the cursor check
// (layers/core/server/pipeline/judge/submit.ts › checkCursor) — that run is recorded and
// nothing else is; the 200 carries counts, including grounding rejections,
// because a partially accepted run is still a run.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import sourcesYaml from 'raw:~~/sources.yaml'

import { blobRawReader } from '#layers/core/server/utils/pipeline-raw'
import { submitJudgeRun } from '../../pipeline/judge/submit'
import { requireJudgeToken } from '#layers/core/server/utils/judge-auth'

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

  const nitro = useNitroApp()
  const report = await submitJudgeRun(db, raw, {
    source: 'routine',
    readRaw: blobRawReader(blob),
    sourcesYaml,
    applied: (ctx) => nitro.hooks.callHook('judge:applied', ctx),
  })
  if (report.gate_rejection) {
    throw createError({
      statusCode: 422,
      message: 'Judge output rejected whole (schema gate or cursor check)',
      data: report.gate_rejection,
    })
  }
  return { schema: 1, ...report }
})
