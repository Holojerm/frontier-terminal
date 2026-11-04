// Bearer check for /api/press/*: the press-drafts routine presents
// NUXT_PRESS_TOKEN. Its own token, not the judge's, because the two routines
// hold different powers (this one reaches the press list) and rotate apart.
// Same verdicts as the judge: 404 with no token configured, 401 on a mismatch.

import type { H3Event } from 'h3'

import { verifyJudgeToken } from './judge-auth'

export async function requirePressToken(event: H3Event): Promise<void> {
  const verdict = await verifyJudgeToken(
    getRequestHeader(event, 'authorization'),
    useRuntimeConfig(event).pressToken,
  )
  if (verdict.ok) return
  if (verdict.status === 401) setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
  throw createError({
    statusCode: verdict.status,
    message: verdict.status === 404 ? 'Not found' : 'Unauthorized',
  })
}
