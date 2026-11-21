import type { PollScope } from '../utils/contracts'
import type { FetchSource } from '../utils/pipeline-sources'
import { SCOPE_ENTRIES } from '#server/registries/scopes'

// Which sources each cron tick polls. The policy is here; each domain's
// ScopeEntry says which sources ride which tick (server/registries/scopes.ts ›
// SCOPE_ENTRIES).
//
//   edgar   */30 * * * *   SEC feeds and the vendors' model catalogs, where
//                          latency matters ('edgar' is the stored name).
//   survey  0 */6 * * *    every include source but careers' and filings'. It
//                          re-checks edgar's sources, so a stalled edgar tick
//                          stays covered.
//   careers 17 */6 * * *   the careers feeds too big to share the survey.
//   filings 47 */6 * * *   the registration filings (~14 MB prospectuses).
//
// A Worker invocation has 128 MB, and a payload is held as bytes, as a string
// and again while hashed and archived; google-careers' first tick killed the
// survey for memory, losing every source not yet recorded. So big sources get
// their own tick, on minutes no other trigger uses.
//
// At the shared six-hourly instant edgar yields to the survey (poll.ts).

/** One domain's share of a tick's sources, in the order the tick polls them. */
export interface ScopeEntry {
  /** Sources named outright; each must be in sources.yaml. */
  sources?: readonly string[]
  /** Every other source whose id starts with one of these (derived sources), in sources order. */
  prefixes?: readonly string[]
  /**
   * Derived sources that ride the tick only until each has parsed once, while
   * `fresh` says the key after the prefix is still news at `now` (ISO).
   */
  untilParsed?: {
    prefixes: readonly string[]
    fresh: (key: string, now: string) => boolean
  }
}

/** The ticks with their own invocation: the survey leaves their sources to them. */
const OWN_TICK: readonly PollScope[] = ['careers', 'filings']

const entriesOf = (scope: PollScope): readonly ScopeEntry[] => SCOPE_ENTRIES[scope] ?? []

const matches = (prefixes: readonly string[] | undefined, id: string) =>
  prefixes?.some((p) => id.startsWith(p)) ?? false

/** True when the entry names `id` or claims it by prefix. */
const claims = (entry: ScopeEntry, id: string) =>
  (entry.sources?.includes(id) ?? false) || matches(entry.prefixes, id)

/** True for a source that rides a tick only until it parses once (ScopeEntry.untilParsed). */
export function isUntilParsedSource(id: string): boolean {
  return Object.values(SCOPE_ENTRIES)
    .flatMap((entries) => entries ?? [])
    .some((e) => matches(e.untilParsed?.prefixes, id))
}

function freshUnparsed(entry: ScopeEntry, id: string, now: Date): boolean {
  const prefix = entry.untilParsed?.prefixes.find((p) => id.startsWith(p))
  return (
    prefix !== undefined && entry.untilParsed!.fresh(id.slice(prefix.length), now.toISOString())
  )
}

/**
 * The source ids a tick polls. `parsed` is the until-parsed sources that have
 * already parsed once (store.ts › sourcesWithGoodRun); the tick skips them.
 */
export function sourceIdsForScope(
  scope: PollScope,
  all: readonly FetchSource[],
  now: Date = new Date(),
  parsed: ReadonlySet<string> = new Set(),
): string[] {
  const ids = all.map((s) => s.source_id)
  if (scope === 'survey') {
    const own = OWN_TICK.flatMap(entriesOf)
    return ids.filter((id) => !own.some((e) => claims(e, id)))
  }
  const entries = entriesOf(scope)
  const missing = entries.flatMap((e) => e.sources ?? []).filter((id) => !ids.includes(id))
  if (missing.length) {
    throw new Error(`${scope} scope names sources not in sources.yaml: ${missing.join(', ')}`)
  }
  return entries.flatMap((e) => [
    ...(e.sources ?? []),
    ...ids.filter((id) => matches(e.prefixes, id) && !e.sources?.includes(id)),
    ...ids.filter((id) => freshUnparsed(e, id, now) && !parsed.has(id)),
  ])
}

/**
 * How often we say a source is checked, in minutes (/about#latency): the
 * edgar tick's sources every 30, everything else on the six-hourly survey,
 * careers or filings lane. A source that rides the edgar tick only until it
 * parses counts as six-hourly.
 */
export function statedIntervalMinutes(sourceId: string): number {
  return entriesOf('edgar').some((e) => claims(e, sourceId)) ? 30 : 360
}

const EDGAR_PERIOD_MS = 30 * 60 * 1000
const SURVEY_PERIOD_MS = 6 * 60 * 60 * 1000

/**
 * True when `now` is one of the survey's six-hourly instants (00:00, 06:00,
 * 12:00, 18:00 UTC). The cron fires on the minute and the task starts a few
 * seconds later, so the time is rounded to the nearest edgar tick (30 min)
 * before the check, never compared for equality. Pure; mirrors the two
 * expressions in SCHEDULED_TASKS (nuxt.config.ts).
 */
export function isSurveyInstant(now: Date): boolean {
  const msIntoDay =
    now.getUTCHours() * 3_600_000 +
    now.getUTCMinutes() * 60_000 +
    now.getUTCSeconds() * 1000 +
    now.getUTCMilliseconds()
  const nearestEdgarTick = Math.round(msIntoDay / EDGAR_PERIOD_MS) * EDGAR_PERIOD_MS
  return nearestEdgarTick % SURVEY_PERIOD_MS === 0
}
