import type { PollScope } from './contracts'
import { freshRegistrationKey } from './prospectus-floor'
import type { FetchSource } from './sources'

// Which sources each cron tick polls. One file, so the two tasks under
// layers/terminal/server/tasks/poll/ share a policy instead of two lists that drift.
//
//   edgar   */30 * * * *   the SEC feeds — the FTS tripwire, one submissions
//                          feed per whitelisted CIK, and company facts for
//                          each tagged revenue filer — plus the model catalogs
//                          (LAUNCH_SOURCES): the two axes where latency is
//                          worth polling for. The scope keeps its stored name
//                          'edgar' (pollScopeEnum, source_runs, /api/status).
//   survey  0 */6 * * *    every include source but the careers and filings
//                          lanes'. It re-checks EDGAR on purpose: an unchanged
//                          re-fetch diffs to zero, and the overlap means a
//                          stalled edgar tick goes covered, not blind.
//   careers 17 */6 * * *   CAREERS_SOURCES, alone in their own invocation.
//   filings 47 */6 * * *   the registration filings (REGISTRATION_PREFIXES):
//                          three ~14 MB prospectuses by 2026-11-10, which put
//                          the survey over its budget.
//
// A Worker invocation has 128 MB, and a payload is held as bytes, as a string,
// and again while it is hashed and archived. The 2026-11-04 18:00 survey was
// killed for memory (exceededMemory, 4.9 s CPU) on google-careers' first tick,
// and a kill loses every source the tick had not yet recorded. A source that
// big runs on its own tick, so its footprint can never take the survey down.
// Minute 17 is one no other trigger fires on (the five-minute crons land on
// :15 and :20), and well after the survey has released the poll lock.
//
// Because 6h is a multiple of 30m the two are due at the same instant every
// sixth hour. The survey is a superset, so at that instant edgar yields
// (layers/terminal/server/pipeline/poll.ts) rather than racing it for the lock.

const EDGAR_SOURCES: readonly string[] = [
  'edgar-fts',
  'edgar-fts-openai',
  'edgar-submissions-spcx',
  'edgar-submissions-msft',
  'edgar-submissions-amzn',
  'edgar-submissions-nvda',
  'edgar-submissions-googl',
  'edgar-submissions-meta',
  'edgar-submissions-orcl',
  'edgar-submissions-baba',
  'edgar-companyfacts-spcx',
]

// A model launch lands on these pages first: the vendor's own price list and
// catalog. On the six-hourly survey alone a launch could sit unreported for
// most of a working day; on this tick it waits at most 30 minutes. Each is one
// small document hashed against the last, so an unchanged re-fetch diffs to
// zero. OpenRouter's model list stays on the survey: it has no lane (a
// cross-check, never a source of record — lanes.ts), so polling it faster
// would only store bytes. The derived per-model OpenAI pages stay there too:
// they add context windows to a SKU these pages already announced.
const LAUNCH_SOURCES: readonly string[] = [
  'openai-models-md',
  'openai-pricing-md',
  'anthropic-models-md',
  'anthropic-pricing-md',
  'xai-models-md',
  'google-pricing-html',
  'google-models-md',
  'meta-models-md',
  'meta-pricing-md',
  'mistral-models-md',
  'mistral-pricing-md',
  'deepseek-pricing-md',
  'alibaba-pricing-html',
  'alibaba-models-html',
  'moonshot-models-md',
]

// Alphabet's whole careers feed, ~20 MB of XML, read for DeepMind's ~140 roles.
export const CAREERS_SOURCES: readonly string[] = ['google-careers']

// A fresh registration filing's index and document ride the edgar tick until
// each has parsed once, so what an S-1 amendment says reaches an alert within
// an hour of the filing rather than at the next six-hourly tick. After that
// only the filings lane re-checks them: a filed document never changes, and a
// prospectus runs to 14 MB.
export const REGISTRATION_PREFIXES = ['filing-index-', 'prospectus-revenue-']

export function isRegistrationSource(id: string): boolean {
  return REGISTRATION_PREFIXES.some((p) => id.startsWith(p))
}

function freshRegistration(id: string, now: Date): boolean {
  const prefix = REGISTRATION_PREFIXES.find((p) => id.startsWith(p))
  return prefix !== undefined && freshRegistrationKey(id.slice(prefix.length), now.toISOString())
}

/**
 * The source ids a tick polls. `parsed` is the registration sources that have
 * already parsed once (store.ts › sourcesWithGoodRun); the edgar tick skips them.
 */
export function sourceIdsForScope(
  scope: PollScope,
  all: readonly FetchSource[],
  now: Date = new Date(),
  parsed: ReadonlySet<string> = new Set(),
): string[] {
  const ids = all.map((s) => s.source_id)
  if (scope === 'careers') {
    const missing = CAREERS_SOURCES.filter((id) => !ids.includes(id))
    if (missing.length) {
      throw new Error(`careers scope names sources not in sources.yaml: ${missing.join(', ')}`)
    }
    return [...CAREERS_SOURCES]
  }
  if (scope === 'filings') return ids.filter(isRegistrationSource)
  if (scope === 'survey') {
    return ids.filter((id) => !CAREERS_SOURCES.includes(id) && !isRegistrationSource(id))
  }
  const missing = [...EDGAR_SOURCES, ...LAUNCH_SOURCES].filter((id) => !ids.includes(id))
  if (missing.length) {
    throw new Error(`edgar scope names sources not in sources.yaml: ${missing.join(', ')}`)
  }
  // Derived EDGAR feeds (a resolved lab's submissions and company facts —
  // layers/terminal/server/pipeline/derived.ts) ride the same tick as the static ones.
  const derived = ids.filter((id) => id.startsWith('edgar-') && !EDGAR_SOURCES.includes(id))
  const registrations = ids.filter((id) => freshRegistration(id, now) && !parsed.has(id))
  return [...EDGAR_SOURCES, ...derived, ...registrations, ...LAUNCH_SOURCES]
}

/**
 * How often we say a source is checked, in minutes (/about#latency): the
 * edgar tick's feeds and catalogs every 30, everything else on the six-hourly
 * survey, careers or filings lane. A fresh registration filing rides the edgar tick
 * only until it parses, so it counts as six-hourly.
 */
export function statedIntervalMinutes(sourceId: string): number {
  const edgarTick =
    EDGAR_SOURCES.includes(sourceId) ||
    LAUNCH_SOURCES.includes(sourceId) ||
    sourceId.startsWith('edgar-')
  return edgarTick ? 30 : 360
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
