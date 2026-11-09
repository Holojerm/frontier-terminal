// h3's router does not fall back from HEAD to GET, so a download route answers
// HEAD through a .head.ts twin that re-exports its GET handler and stops here
// once the headers are set. Link checkers and data clients send HEAD first.

import type { H3Event } from 'h3'

/** The headers set so far with no body. Returning null instead would be a 204. */
export function headResponse(event: H3Event, contentLength?: number): Response {
  return new Response(null, {
    status: 200,
    headers: {
      ...getResponseHeaders(event),
      ...(contentLength === undefined ? {} : { 'Content-Length': String(contentLength) }),
    } as Record<string, string>,
  })
}
