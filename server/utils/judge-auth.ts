// Bearer check for /api/judge/*.
//
// The judge routine runs on the owner's claude.ai account with no session
// here, so it presents NUXT_JUDGE_TOKEN — the same shape as the fleet
// dashboard's bearer, checked by the same function (SHA-256 digests under a
// constant-time compare, 32-character floor). The verdicts map to the same
// two non-200s as /api/fleet, for the same reasons: 404 when no token is
// configured, so a Worker without a judge advertises nothing, and a loud
// 401 when one is and the request did not present it.
//
// One wart from the reuse: a too-short token logs `fleet_token_too_short`.

import type { H3Event } from 'h3'

import { verifyFleetToken } from './fleet-auth'

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
