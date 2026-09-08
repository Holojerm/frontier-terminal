// What every terminal API route does around its query: read the poll tick,
// build the query context, and serve the payload through the KV cache. The
// five routes under server/api/ are one line each because of this.
//
// `db` and `kv` are imported explicitly, not auto-imported — the auto-import
// typechecks everywhere and is not injected everywhere at runtime
// (.claude/docs/gotchas.md › kv auto-import).

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'
import type { H3Event } from 'h3'

import sourcesYaml from 'raw:../../sources.yaml'

import { cachedTerminal, terminalStamp } from './terminal-cache'
import { queryContext, type QueryContext } from './terminal-db'

/** Five minutes at the edge too — the same window as the KV entry. */
export const TERMINAL_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=240'

/**
 * The payload for `name` in the current tick, computed with `query` on a
 * cache miss. An empty database is an ordinary case here: every query
 * returns an honest empty shape, never a 500. A database that cannot be
 * reached is the one thing that should fail loudly — Nitro turns the throw
 * into a 503 and the error plugin spools an ops event.
 *
 * Takes no event so the MCP tools (server/utils/mcp.ts) read through the
 * same KV entries the JSON routes fill: one cache, whichever door a client
 * comes in by.
 */
export async function terminalPayload<T>(
  name: string,
  query: (context: QueryContext) => Promise<T>,
  // The cache key must include anything that changes the payload. A route
  // with input (alerts?limit=) passes it here.
  variant = '',
): Promise<T> {
  let stamp: string | null
  try {
    stamp = await terminalStamp(db)
  } catch (error) {
    throw createError({ statusCode: 503, message: 'Database unavailable', cause: error })
  }
  const context = queryContext(sourcesYaml, stamp)
  return cachedTerminal(kv, variant ? `${name}:${variant}` : name, stamp, () => query(context))
}

/** `terminalPayload`, plus the edge Cache-Control every JSON route sends. */
export async function serveTerminal<T>(
  event: H3Event,
  name: string,
  query: (context: QueryContext) => Promise<T>,
  variant = '',
): Promise<T> {
  setResponseHeader(event, 'Cache-Control', TERMINAL_CACHE_CONTROL)
  return terminalPayload(name, query, variant)
}

/** The Drizzle client, for routes that stream rather than cache. */
export { db as terminalDb }
