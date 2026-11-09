// A D1 failure inside a route's query is a 503 like one in the stamp read
// (terminal-handler.ts › liveStamp), not a bare 500: #182 was a query that threw
// past that mapping, so the status and the digest called it a bug in our code.

import { createError } from 'h3'

const D1_FAULT = /^Failed query: |D1_|SQLITE_|Network connection lost|storage (?:operation|caused)/i

function messages(error: unknown): string[] {
  const out: string[] = []
  for (let e = error, depth = 0; e != null && depth < 3; depth++) {
    out.push((e as { message?: string }).message ?? String(e))
    e = (e as { cause?: unknown }).cause
  }
  return out
}

/** Whether `error` is the database failing, as opposed to our code or a deliberate HTTP error. */
export function isD1Fault(error: unknown): boolean {
  if (typeof (error as { statusCode?: unknown } | null)?.statusCode === 'number') return false
  return messages(error).some((m) => D1_FAULT.test(m))
}

/** Rethrows a D1 fault as a 503 carrying the original as `cause`; anything else unchanged. */
export function asDatabaseFault(error: unknown): unknown {
  return isD1Fault(error)
    ? createError({ statusCode: 503, message: 'Database unavailable', cause: error })
    : error
}

/** `query`, with a D1 fault in it thrown as a 503. */
export function withDatabaseFault<A extends unknown[], T>(
  query: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return async (...args) => {
    try {
      return await query(...args)
    } catch (error) {
      throw asDatabaseFault(error)
    }
  }
}
