// POST /api/judge/alerts: the judge routine's verdicts, bearer NUXT_JUDGE_TOKEN
// (layers/core/server/utils/judge-auth.ts). The body is gated raw, as text, so
// the schema sees exactly what the model produced; survivors are grounded
// against the cited change rows as D1 holds them and written through
// layers/core/server/pipeline/judge/submit.ts. 422 when the whole body fails the
// schema gate or the cursor check; otherwise 200 with counts, since a partially
// accepted run is still a run.

import sourcesYaml from 'raw:~~/sources.yaml'

import { submitJudgeRun } from '../../pipeline/judge/submit'

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
