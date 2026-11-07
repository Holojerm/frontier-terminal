// What every terminal API route does around its query: read the poll tick,
// build the query context, and serve the payload through the KV cache. The
// routes under server/api/ are a line or two each because of this.
//
// Freshness differs by door, on purpose: a JSON response may trail the newest
// stamp by up to five minutes at the edge (fresh for one, then served stale
// while revalidating: TERMINAL_CACHE_CONTROL), while the HTML cache
// (plugins/html-cache.ts) is keyed on the stamp and never serves a page
// rendered from an older one.
//
// `db` and `kv` are imported explicitly, not auto-imported — the auto-import
// typechecks everywhere and is not injected everywhere at runtime
// (.claude/docs/gotchas.md › kv auto-import).

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'
import type { H3Event } from 'h3'

import sourcesYaml from 'raw:~~/sources.yaml'

import { LICENSE_SPLIT_EFFECTIVE, asOfLicense } from '#shared/utils/license'

import {
  AS_OF_PARAM,
  PointInTimeError,
  asOfRefusal,
  assertKnowable,
  parseAsOfQuery,
  pointInTimeMeta,
  pollStampAt,
  type AsOfPayload,
  type PointInTimeMeta,
} from './terminal-asof'
import { cacheControlFor, resolvedApiKey } from './api-access'
import { assertArchiveKnowable } from './terminal-archive'
import { serverTimingHeader, timed, type ServerTiming } from './server-timing'
import { paidLicensed, served } from './terminal-envelope'
import {
  cachedTerminal,
  sharedTerminalStamp,
  terminalStamps,
  type CacheOptions,
  type TerminalStamps,
} from './terminal-cache'
import { queryContext, type QueryContext } from './terminal-db'

/** A minute fresh at the edge, then up to four more served stale while revalidating. The KV entry is keyed by the data stamp, so it never outlives the data. */
export const TERMINAL_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=240'

/**
 * How a route answers `as_of`. 'none' refuses it (refuseAsOf); the others
 * rebuild the payload at the instant and differ only in which instants they
 * refuse: 'snapshot' one before the store's first snapshot, 'pricing' and
 * 'hiring' one before that axis's Internet Archive backfill
 * (terminal-archive.ts), and 'filed' none, since filed facts are read by
 * filing date.
 */
export type AsOfMode = 'none' | 'snapshot' | 'pricing' | 'hiring' | 'filed'
export type RebuiltAsOf = Exclude<AsOfMode, 'none'>

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
  return served(
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
  asOf: RebuiltAsOf = 'snapshot',
  options: CacheOptions = {},
): Promise<AsOfPayload<T>> {
  const stamp = await timed(options.timings, 'stamp', liveStamp)
  try {
    if (asOf === 'snapshot') await assertKnowable(db, at)
    else if (asOf !== 'filed') await assertArchiveKnowable(db, at, asOf)
  } catch (error) {
    if (error instanceof PointInTimeError) {
      throw createError({ statusCode: 400, message: error.message })
    }
    throw error
  }
  const context = queryContext(sourcesYaml, await pollStampAt(db, at), undefined, at)
  // eventTime rides beside the payload: on a hit the query does not run, so
  // ctx.notes is empty and the entry has to remember it.
  type Entry = { data: T & { point_in_time: PointInTimeMeta }; eventTime: boolean } | null
  const entry = await cachedTerminal<Entry>(
    kv,
    cacheName(name, `${variant}|${AS_OF_PARAM}=${at}`),
    stamp.key,
    async () => {
      const data = await query(context)
      // null is "not known at T" (an unknown SKU), which the route turns into its 404.
      if (data === null) return null
      const point_in_time = pointInTimeMeta(at, context.notes)
      return { data: { ...data, point_in_time }, eventTime: context.notes.eventTime }
    },
    options,
  )
  if (entry === null) return null as AsOfPayload<T>
  const { data, eventTime } = entry
  const published = eventTime ? EVENT_TIME_PUBLISHED : at
  return served({
    ...data,
    point_in_time: {
      ...data.point_in_time,
      license: asOfLicense(at, undefined, undefined, published),
    },
  }) as AsOfPayload<T>
}

/**
 * The archive backfill and the filed facts both landed on the split day
 * (2026-11-04), so data an event-time answer reads was published here no
 * earlier than that, however old the instant it describes.
 */
const EVENT_TIME_PUBLISHED = LICENSE_SPLIT_EFFECTIVE

async function liveStamp(): Promise<TerminalStamps> {
  try {
    return await sharedTerminalStamp(() => terminalStamps(db))
  } catch (error) {
    throw createError({ statusCode: 503, message: 'Database unavailable', cause: error })
  }
}

// The build is part of the key: a deploy that changes what a query returns
// (its code, a thesis definition) must not be served the previous build's
// payload until the next poll.
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
  'page-data':
    'it returns the live page’s own hydration payload. Ask the API route the page reads from with as_of instead.',
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

interface ServeOptions {
  /** Anything besides the stamps that changes the payload: the route's input. */
  variant?: string
  asOf?: AsOfMode
}

/**
 * `terminalPayload`, plus the edge Cache-Control every JSON route sends. With
 * `asOf` other than 'none' a request carrying `as_of` is rebuilt at that
 * instant (terminalPayloadAt); without, it is refused rather than handed
 * today's payload.
 */
export function serveTerminal<T>(
  event: H3Event,
  name: string,
  query: (context: QueryContext) => Promise<T>,
  options?: ServeOptions & { asOf?: 'none' },
): Promise<T>
export function serveTerminal<T extends object | null>(
  event: H3Event,
  name: string,
  query: (context: QueryContext) => Promise<T>,
  options: ServeOptions & { asOf: RebuiltAsOf },
): Promise<T | AsOfPayload<T>>
export async function serveTerminal(
  event: H3Event,
  name: string,
  query: (context: QueryContext) => Promise<object | null>,
  { variant = '', asOf = 'none' }: ServeOptions = {},
): Promise<unknown> {
  let at: string | undefined
  if (asOf === 'none') refuseAsOf(event, name)
  else at = (await getValidatedQuery(event, parseAsOfQuery)).as_of
  setResponseHeader(event, 'Cache-Control', cacheControlFor(event, TERMINAL_CACHE_CONTROL))
  const options: CacheOptions & { timings: ServerTiming[] } = {
    timings: [],
    // The KV write on a miss runs after the response is sent.
    defer: (promise) => event.waitUntil(promise),
  }
  const payload =
    at === undefined || asOf === 'none'
      ? await terminalPayload(name, query, variant, options)
      : await terminalPayloadAt(name, at, query, variant, asOf, options)
  setResponseHeader(event, 'Server-Timing', serverTimingHeader(options.timings))
  // A licensee's key carries the paid license on older data in place of CC
  // BY-NC (PAID_LICENSE). Nothing else in the payload changes with a key.
  if (!resolvedApiKey(event) || payload === null || typeof payload !== 'object') return payload
  return paidLicensed(payload)
}

/** The Drizzle client, for routes that stream rather than cache. */
export { db as terminalDb }
