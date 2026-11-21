// GET /api/relay/work — the URLs on relayed hosts (core pipeline/relay.ts) the
// pipeline asked for lately, each with the User-Agent to send, for the Mac
// mini's relay job (scripts/relay-fetch.ts). Bearer-gated with the mini's token.

import { kv } from '@nuxthub/kv'

import { userAgentFor } from '#layers/core/server/pipeline/fetch'
import { wantedUrls } from '#layers/core/server/pipeline/relay'
import { requireGdeltToken } from '../../utils/gdelt-auth'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'relay', limit: 60, windowSeconds: 60 })
  await requireGdeltToken(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const config = useRuntimeConfig(event)
  const options = { secContactEmail: '', appUrl: config.public.appUrl }
  return {
    urls: (await wantedUrls(kv)).map((url) => ({ url, user_agent: userAgentFor(url, options) })),
  }
})
