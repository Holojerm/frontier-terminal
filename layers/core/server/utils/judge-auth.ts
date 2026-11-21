// Bearer check for /api/judge/*: NUXT_JUDGE_TOKEN, checked by the fleet
// bearer's function (constant-time SHA-256 compare, 32-character floor, so a
// short token logs `fleet_token_too_short`). 404 when no token is configured,
// so a Worker without a judge advertises nothing; 401 on a missing or wrong one.

import type { H3Event } from 'h3'

export type JudgeAuthVerdict = { ok: true } | { ok: false; status: 401 | 404 }

/** Pure: the verdict for a request header against the configured token. */
export async function verifyJudgeToken(
  authorization: string | null | undefined,
  token: string | undefined,
): Promise<JudgeAuthVerdict> {
  const verdict = await verifyFleetToken(authorization, { current: token })
  if (verdict === 'ok') return { ok: true }
  return { ok: false, status: verdict === 'unconfigured' ? 404 : 401 }
}

export async function requireJudgeToken(event: H3Event): Promise<void> {
  const verdict = await verifyJudgeToken(
    getRequestHeader(event, 'authorization'),
    useRuntimeConfig(event).judgeToken,
  )
  if (verdict.ok) return
  if (verdict.status === 401) setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
  throw createError({
    statusCode: verdict.status,
    message: verdict.status === 404 ? 'Not found' : 'Unauthorized',
  })
}
