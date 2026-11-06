// Bearer check for /api/gdelt/*: the GitHub Actions job that runs the GDELT
// side of the track record (scripts/gdelt-search.ts) presents
// NUXT_GDELT_TOKEN, held there as the repository secret GDELT_TOKEN. Its own
// token, not the judge's: it lives on GitHub, not in a claude.ai routine, and
// rotates apart. Same verdicts as the judge: 404 with no token configured,
// 401 on a mismatch.

import type { H3Event } from 'h3'

import { verifyJudgeToken } from './judge-auth'

export async function requireGdeltToken(event: H3Event): Promise<void> {
  const verdict = await verifyJudgeToken(
    getRequestHeader(event, 'authorization'),
    useRuntimeConfig(event).gdeltToken,
  )
  if (verdict.ok) return
  if (verdict.status === 401) setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
  throw createError({
    statusCode: verdict.status,
    message: verdict.status === 404 ? 'Not found' : 'Unauthorized',
  })
}
