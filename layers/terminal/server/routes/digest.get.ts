// GET /digest — this week's thesis digest rendered as a page, so a reader can
// see what the email is before subscribing. The subscriber copy without an
// unsubscribe link. 404 with the rest of the feature until Resend is set up.

import { rateLimit } from '#server/utils/rate-limit'

import { buildThesisDigest } from '../theses/digest'
import { loadDigestInput } from '../utils/digest-input'
import { requireSubscribe } from '../utils/subscribe-config'

export default defineEventHandler(async (event) => {
  const cfg = requireSubscribe(event)
  await rateLimit(event, { name: 'digest-sample', limit: 20, windowSeconds: 60 })
  const input = await loadDigestInput(new Date())
  const digest = buildThesisDigest({
    ...input,
    appName: cfg.appName,
    appUrl: cfg.appUrl,
    audience: 'public',
  })
  setResponseHeaders(event, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'X-Robots-Tag': 'noindex',
  })
  return digest.html
})
