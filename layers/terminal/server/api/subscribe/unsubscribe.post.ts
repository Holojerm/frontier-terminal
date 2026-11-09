// POST /api/subscribe/unsubscribe — two callers, one token. The unsubscribe
// page posts `{ token }`. A mail client's one-click unsubscribe (RFC 8058)
// posts `List-Unsubscribe=One-Click` to the List-Unsubscribe URL, which carries
// the token as `?u=`. Both are POSTs because Workers drop DELETE bodies and a
// GET must never change state.

import { db } from '@nuxthub/db'

import { getIdentitySalt } from '#server/utils/identity'
import { rateLimit } from '#server/utils/rate-limit'

import { tokenBody } from '../../../shared/utils/subscribe'
import { requireSubscribe } from '../../utils/subscribe-config'
import { unsubscribe } from '../../utils/subscribers'

export default defineEventHandler(async (event) => {
  requireSubscribe(event)
  // Mail providers fan one-click POSTs out across colos: 60 per 2 minutes is
  // not a native-limiter budget, so this counts globally in KV.
  await rateLimit(event, { name: 'subscribe-unsubscribe', limit: 60, windowSeconds: 120 })

  const fromQuery = getQuery(event).u
  const token =
    typeof fromQuery === 'string'
      ? fromQuery
      : tokenBody.safeParse(await readBody(event)).data?.token
  const outcome = token
    ? await unsubscribe(db, await getIdentitySalt(db), token, new Date())
    : 'invalid'
  if (outcome === 'invalid') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      data: { code: 'invalid_token' },
    })
  }
  return { ok: true }
})
