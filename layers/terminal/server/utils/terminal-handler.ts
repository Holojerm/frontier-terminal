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

import sourcesYaml from 'raw:~~/sources.yaml'

import { asOfLicense, withLicense } from '#shared/utils/license'

import {
  AS_OF_PARAM,
  PointInTimeError,
  asOfRefusal,
  assertKnowable,
  parseAsOfQuery,
  pointInTimeMeta,
  pollStampAt,
  type AsOfPayload,
} from './terminal-asof'
import { cacheControlFor, resolvedApiKey } from './api-access'
import { assertArchiveKnowable } from './terminal-archive'
import { serverTimingHeader, timed, type ServerTiming } from './server-timing'
import { paidLicensed, withSchemaVersion } from './terminal-envelope'
import {
  cachedTerminal,
  sharedTerminalStamp,
  terminalStamps,
  type CacheOptions,
  type TerminalStamps,
} from './terminal-cache'
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
 * Takes no event so the MCP tools (layers/terminal/server/utils/mcp.ts) read through the
 * same KV entries the JSON routes fill: one cache, whichever door a client
 * comes in by.
 */
export async function terminalPayload<T>(
  name: string,
  query: (context: QueryContext) => Promise<T>,
  // The cache key must include anything that changes the payload. A route
  // with input (alerts?limit=) passes it here.
  variant = '',
  options: CacheOptions = {},
): Promise<T> {
  const stamp = await timed(options.timings, 'stamp', liveStamp)
  const context = queryContext(sourcesYaml, stamp.poll)
  // The license is added after the cache: its window moves daily, and a
  // cached payload must not carry yesterday's.
  return withLicense(
    await cachedTerminal(kv, cacheName(name, variant), stamp.key, () => query(context), options),
  )
}

/**
 * `terminalPayload` as of the instant `at` (a validated `as_of`): the query
 * runs with ctx.at set and the payload carries `point_in_time`. The entry is
 * keyed on `at` as well as the live stamp, so a historical payload and the
 * live one never share a key, and a poll still rotates both — a late write
 * about an earlier instant (a judge alert) is picked up on the next tick.
 */
export async function terminalPayloadAt<T extends object | null>(
  name: string,
  at: string,
  query: (context: QueryContext) => Promise<T>,
  variant = '',
  /**
   * `filed`: the query reads filed facts by their filing date (event time), so
   * an instant before our first snapshot is still answerable and is not refused.
   */
  options: CacheOptions & { filed?: boolean; archived?: boolean | 'hiring' } = {},
): Promise<AsOfPayload<T>> {
  const stamp = await timed(options.timings, 'stamp', liveStamp)
  try {
    // `archived`: a price route (true) or a hiring route ('hiring'), which
    // answers an instant before our first snapshot from the Internet Archive
    // backfill (terminal-archive.ts).
    if (options.archived) {
      await assertArchiveKnowable(db, at, options.archived === 'hiring' ? 'hiring' : 'pricing')
    } else if (!options.filed) await assertKnowable(db, at)
  } catch (error) {
    if (error instanceof PointInTimeError) {
      throw createError({ statusCode: 400, message: error.message })
    }
    throw error
  }
  const context = queryContext(sourcesYaml, await pollStampAt(db, at), undefined, at)
  return cachedTerminal(
    kv,
    cacheName(name, `${variant}|${AS_OF_PARAM}=${at}`),
    stamp.key,
    async () => {
      const data = await query(context)
      // null is "not known at T" (an unknown SKU), which the route turns into its 404.
      return (
        data === null ? null : { ...data, point_in_time: pointInTimeMeta(at, context.notes) }
      ) as AsOfPayload<T>
    },
    options,
  ).then((payload) =>
    payload === null
      ? payload
      : withLicense({
          ...payload,
          point_in_time: { ...payload.point_in_time, license: asOfLicense(at) },
        }),
  )
}

async function liveStamp(): Promise<TerminalStamps> {
  try {
    return await sharedTerminalStamp(() => terminalStamps(db))
  } catch (error) {
    throw createError({ statusCode: 503, message: 'Database unavailable', cause: error })
  }
}

// The build is part of the key: a deploy that changes what a query returns
// must not be served the previous build's payload until the next poll.
function cacheName(name: string, variant: string): string {
  const build = useRuntimeConfig().public.buildSha || 'dev'
  return `${name}@${build}${variant ? `:${variant}` : ''}`
}

/** Why each route that cannot answer `as_of` cannot, keyed by its cache name. */
const AS_OF_REFUSALS: Readonly<Record<string, string>> = {
  overview:
    'its movement window and table totals are kept for the present only (source_stats counts are not dated).',
  coverage: 'per-source counts and recipe state are current-state counters with no history.',
  theses:
    'claim readings are rewritten in place as trailing data is revised, and statuses are recomputed with the thesis definitions in today’s code. The judge’s verdicts are at /export/claim_verdicts.csv?as_of=.',
  alert:
    'an alert is never rewritten, so its row is the same at every moment after it was raised. Use /api/alerts?as_of= to see which alerts existed then.',
  identifiers:
    'it’s a registry kept in code, and each identifier is dated by its own fetched_at instead.',
}

/** A 400 for a route that does not rebuild its payload as of T. Never ignore it. */
export function refuseAsOf(event: H3Event, name: string): void {
  if (getQuery(event)[AS_OF_PARAM] === undefined) return
  throw createError({
    statusCode: 400,
    message: asOfRefusal(
      event.path.split('?')[0]!,
      AS_OF_REFUSALS[name] ?? 'this response isn’t rebuilt from stored history yet.',
      '/export/<table> for every append-only table',
    ),
  })
}

/**
 * `terminalPayload`, plus the edge Cache-Control every JSON route sends. A
 * route served through here does not answer `as_of`, so a request carrying
 * one is refused rather than handed today's payload.
 */
export async function serveTerminal<T>(
  event: H3Event,
  name: string,
  query: (context: QueryContext) => Promise<T>,
  variant = '',
): Promise<T> {
  refuseAsOf(event, name)
  setResponseHeader(event, 'Cache-Control', cacheControlFor(event, TERMINAL_CACHE_CONTROL))
  const options = requestCacheOptions(event)
  const payload = await terminalPayload(name, query, variant, options)
  setResponseHeader(event, 'Server-Timing', serverTimingHeader(options.timings))
  return envelopeFor(event, payload)
}

/**
 * `serveTerminal` for a route whose query honours ctx.at: live without `as_of`,
 * rebuilt with it. `archived`: the query answers an instant before the first
 * snapshot from the archived price history, so only one before that is refused.
 */
export async function serveTerminalAsOf<T extends object | null>(
  event: H3Event,
  name: string,
  query: (context: QueryContext) => Promise<T>,
  variant = '',
  archived: boolean | 'hiring' = false,
): Promise<T | AsOfPayload<T>> {
  const { as_of } = await getValidatedQuery(event, parseAsOfQuery)
  setResponseHeader(event, 'Cache-Control', cacheControlFor(event, TERMINAL_CACHE_CONTROL))
  const options = requestCacheOptions(event)
  const payload =
    as_of === undefined
      ? await terminalPayload(name, query, variant, options)
      : await terminalPayloadAt(name, as_of, query, variant, { ...options, archived })
  setResponseHeader(event, 'Server-Timing', serverTimingHeader(options.timings))
  return envelopeFor(event, payload)
}

/** Timed, and with the KV write after the response: what a request-bound read gets. */
function requestCacheOptions(event: H3Event): CacheOptions & { timings: ServerTiming[] } {
  return { timings: [], defer: (promise) => event.waitUntil(promise) }
}

/**
 * `serveTerminalAsOf` for a route that reads filed facts by filing date
 * (terminal-exposure.ts): `as_of` may name any instant, before the store's
 * first snapshot included.
 */
export async function serveTerminalFiled<T extends object | null>(
  event: H3Event,
  name: string,
  query: (context: QueryContext) => Promise<T>,
  variant = '',
): Promise<T | AsOfPayload<T>> {
  const { as_of } = await getValidatedQuery(event, parseAsOfQuery)
  setResponseHeader(event, 'Cache-Control', cacheControlFor(event, TERMINAL_CACHE_CONTROL))
  const options = requestCacheOptions(event)
  const payload =
    as_of === undefined
      ? await terminalPayload(name, query, variant, options)
      : await terminalPayloadAt(name, as_of, query, variant, { ...options, filed: true })
  setResponseHeader(event, 'Server-Timing', serverTimingHeader(options.timings))
  return envelopeFor(event, payload)
}

/**
 * What a route returns: the payload with its schema version, and for a
 * licensee's key the license that key holds on older data (PAID_LICENSE) in
 * place of CC BY-NC. Nothing else in the payload changes with a key.
 */
export function envelopeFor<T>(event: H3Event, payload: T): T {
  const versioned = withSchemaVersion(payload)
  if (!resolvedApiKey(event) || versioned === null || typeof versioned !== 'object') {
    return versioned
  }
  return paidLicensed(versioned)
}

/** The Drizzle client, for routes that stream rather than cache. */
export { db as terminalDb }
