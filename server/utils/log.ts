// Things that must be true of every log line this app writes.
//
// A leaf on purpose — no imports — so anything can pull it in, including the
// Nitro error plugin that runs before most of the app exists.

/**
 * A request path with the query string and fragment removed, for logging.
 *
 * A query string is where a caller puts the things a log should not keep — a
 * token, a signed parameter, a search term — and a 5xx is exactly the moment a
 * request gets logged in full. A path with no query is still the whole
 * diagnostic value of the field (nobody debugs a 500 from a query string), so
 * there is nothing to trade off.
 *
 * Returns `undefined` for a missing path so callers can pass it straight
 * through to a JSON payload.
 */
export function pathForLog(path: string | undefined): string | undefined {
  if (!path) return undefined
  const cut = path.search(/[?#]/)
  return cut === -1 ? path : path.slice(0, cut)
}

/**
 * An error's message with whatever it wrapped folded in.
 *
 * `createError({ cause })` is how this app rethrows a failure it could not
 * handle — server/utils/terminal-handler.ts turns any D1 fault into one
 * `503 Database unavailable` and hangs the real error off `cause`. The digest
 * that reaches a human carried only the wrapper, so every distinct way the
 * database can fail arrived as the same sentence and the mail said nothing a
 * reader could act on. The cause is the part worth having.
 *
 * Only one level is unwrapped on purpose: a chain deeper than that is a stack
 * trace, and the stack is already on the log line beside this.
 */
export function errorDetail(error: unknown): string {
  const wrapper = error as { message?: string; cause?: unknown } | null
  const message = wrapper?.message ?? String(error)
  const cause = wrapper?.cause
  if (cause === undefined || cause === null) return message
  const inner = (cause as { message?: string }).message ?? String(cause)
  return !inner || inner === message ? message : `${message}: ${inner}`
}
