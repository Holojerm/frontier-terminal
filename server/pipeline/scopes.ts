import type { PollScope } from './contracts'
import type { FetchSource } from './sources'

// Which sources each cron tick polls. One file, so the two tasks under
// server/tasks/poll/ share a policy instead of two lists that drift.
//
//   edgar   */30 * * * *   the two SEC feeds — the tripwire, the one axis where
//                          latency is worth polling for.
//   survey  0 */6 * * *    every include source. It re-checks EDGAR on purpose:
//                          an unchanged re-fetch diffs to zero, and the overlap
//                          means a stalled edgar tick goes covered, not blind.

const EDGAR_SOURCES: readonly string[] = ['edgar-fts', 'edgar-submissions-spcx']

export function sourceIdsForScope(scope: PollScope, all: readonly FetchSource[]): string[] {
  const ids = all.map((s) => s.source_id)
  if (scope === 'survey') return ids
  const missing = EDGAR_SOURCES.filter((id) => !ids.includes(id))
  if (missing.length) {
    throw new Error(`edgar scope names sources not in sources.yaml: ${missing.join(', ')}`)
  }
  return [...EDGAR_SOURCES]
}
