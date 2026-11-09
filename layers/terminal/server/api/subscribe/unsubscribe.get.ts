// GET /api/subscribe/unsubscribe — a client that opens the List-Unsubscribe URL
// in a browser lands on the page, which does the POST. A GET never unsubscribes.

import { requireSubscribe } from '../../utils/subscribe-config'

export default defineEventHandler((event) => {
  requireSubscribe(event)
  const u = getQuery(event).u
  const query = typeof u === 'string' ? `?u=${encodeURIComponent(u)}` : ''
  return sendRedirect(event, `/subscribe/unsubscribe${query}`, 303)
})
