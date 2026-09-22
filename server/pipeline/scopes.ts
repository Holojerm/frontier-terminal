import type { PollScope } from './contracts'
import type { FetchSource } from './sources'

// Which sources each cron tick polls. One file, so the two tasks under
// server/tasks/poll/ share a policy instead of two lists that drift.
//
//   edgar   */30 * * * *   the SEC feeds — the FTS tripwire, one submissions
//                          feed per whitelisted CIK, and company facts for
//                          each tagged revenue filer — plus the model catalogs
//                          (LAUNCH_SOURCES): the two axes where latency is
//                          worth polling for. The scope keeps its stored name
//                          'edgar' (pollScopeEnum, source_runs, /api/status).
//   survey  0 */6 * * *    every include source. It re-checks EDGAR on purpose:
//                          an unchanged re-fetch diffs to zero, and the overlap
//                          means a stalled edgar tick goes covered, not blind.
//
// Because 6h is a multiple of 30m the two are due at the same instant every
// sixth hour. The survey is a superset, so at that instant edgar yields
// (server/pipeline/poll.ts) rather than racing it for the lock.

const EDGAR_SOURCES: readonly string[] = [
  'edgar-fts',
  'edgar-fts-openai',
  'edgar-submissions-spcx',
  'edgar-submissions-msft',
  'edgar-submissions-amzn',
  'edgar-submissions-nvda',
  'edgar-submissions-googl',
  'edgar-companyfacts-spcx',
]

// A model launch lands on these pages first — the vendor's own price list and
// catalog, and OpenRouter's model list, which often carries a new SKU within
// minutes of the announcement. On the six-hourly survey alone a launch could
// sit unreported for most of a working day; on this tick it waits at most 30
// minutes. Each is one small document hashed against the last, so an
// unchanged re-fetch diffs to zero. The derived per-model OpenAI pages stay on
// the survey: they add context windows to a SKU these pages already announced.
const LAUNCH_SOURCES: readonly string[] = [
  'openai-models-md',
  'openai-pricing-md',
  'anthropic-models-md',
  'anthropic-pricing-md',
  'xai-models-md',
  'google-pricing-html',
  'openrouter-models',
]

export function sourceIdsForScope(scope: PollScope, all: readonly FetchSource[]): string[] {
  const ids = all.map((s) => s.source_id)
  if (scope === 'survey') return ids
  const missing = [...EDGAR_SOURCES, ...LAUNCH_SOURCES].filter((id) => !ids.includes(id))
  if (missing.length) {
    throw new Error(`edgar scope names sources not in sources.yaml: ${missing.join(', ')}`)
  }
  // Derived EDGAR feeds (a resolved lab's submissions and company facts —
  // server/pipeline/derived.ts) ride the same tick as the static ones.
  const derived = ids.filter((id) => id.startsWith('edgar-') && !EDGAR_SOURCES.includes(id))
  return [...EDGAR_SOURCES, ...derived, ...LAUNCH_SOURCES]
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
