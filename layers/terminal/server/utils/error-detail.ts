// The part of a 5xx log line that has to say something a reader can act on; pathForLog
// (server/utils/log.ts) is the other half, keeping the query string out.

/**
 * An error's message with whatever it wrapped folded in.
 *
 * `createError({ cause })` is how this app rethrows a failure it could not
 * handle — layers/terminal/server/utils/terminal-handler.ts turns any D1 fault into one
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
