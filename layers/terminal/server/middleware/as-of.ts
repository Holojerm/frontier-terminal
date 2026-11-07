// `as_of` is answered by the API routes that rebuild their payload
// (terminal-handler.ts › serveTerminal with an `asOf` mode), refused by the
// ones that do not (refuseAsOf), and answered or refused per table by /export. Everything
// else — pages, the Atom feed, llms.txt, /mcp, the ops endpoints — renders the
// present, so a URL naming another instant is refused here rather than
// answered with today's data. A page with a query string is never stored in
// the HTML cache (html-cache.ts › isCacheableDocument), so none of this can
// reach it.

import { AS_OF_PARAM, asOfRefusal } from '../utils/terminal-asof'

const ANSWERED_ELSEWHERE = /^\/(export\/|api\/(?!(status|fleet|health|judge)(\/|\?|$)))/

export default defineEventHandler((event) => {
  if (!event.path.includes(AS_OF_PARAM)) return
  if (getQuery(event)[AS_OF_PARAM] === undefined) return
  if (ANSWERED_ELSEWHERE.test(event.path)) return
  throw createError({
    statusCode: 400,
    message: asOfRefusal(
      event.path.split('?')[0]!,
      'pages, feeds and site files show the present, and the MCP tools take as_of as an argument.',
      '/export/<table>',
    ),
  })
})
