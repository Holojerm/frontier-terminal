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
 * trace, and the stack is already on the log line beside this. The one
 * exception is a failed Drizzle query (queryDetail).
 */
export function errorDetail(error: unknown): string {
  const message = messageOf(error)
  const cause = causeOf(error)
  // The cause first: Nitro wraps a thrown query error in an H3Error with the
  // same message, so the query error is one level down.
  const query = [cause, error].find((e) => e != null && messageOf(e).startsWith(FAILED_QUERY))
  if (query !== undefined) return queryDetail(message, query)
  if (cause === undefined || cause === null) return message
  const inner = messageOf(cause)
  return !inner || inner === message ? message : `${message}: ${inner}`
}

const FAILED_QUERY = 'Failed query: '

/**
 * Drizzle's DrizzleQueryError message is the whole statement, one `?` per
 * bound id, then every parameter, and the spool keeps 500 characters
 * (server/utils/ops.ts › recordOpsEvent). So the D1 error it wraps, the only
 * part that says why, was always cut off (#182). The reason goes first, and
 * the statement follows with each `?` run folded to a count.
 */
function queryDetail(message: string, query: unknown): string {
  const statement = messageOf(query)
    .slice(FAILED_QUERY.length)
    .split('\nparams:')[0]!
    .replace(/\?(?:, \?)+/g, (run) => `?×${run.split(',').length}`)
  const reason = causeOf(query)
  const head = [
    message.startsWith(FAILED_QUERY) ? null : message,
    reason == null ? 'query failed' : messageOf(reason),
  ]
  return `${head.filter(Boolean).join(': ')} (in: ${statement})`
}

function messageOf(error: unknown): string {
  return (error as { message?: string } | null)?.message ?? String(error)
}

function causeOf(error: unknown): unknown {
  return (error as { cause?: unknown } | null)?.cause
}
