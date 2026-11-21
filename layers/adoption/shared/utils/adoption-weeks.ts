// The chart side of the weekly adoption series (AdoptionData's `weekly`).
// The API lists only the weeks that have rows, so a chart lays out every
// Monday between the first and the last: a week with no rows then breaks the
// line instead of being bridged.

import type { AdoptionWeek } from './adoption-views'

const DAY_MS = 86_400_000

/** Every Monday from `first` to `last` (both Mondays, YYYY-MM-DD), ascending. */
export function weekColumns(first: string, last: string): string[] {
  const out: string[] = []
  const end = Date.parse(`${last}T00:00:00Z`)
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= end; t += 7 * DAY_MS)
    out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

/**
 * Each column's total, or null where the week is missing, partial, or fails
 * `keep`. A partial week's total covers fewer days, so drawn it would read as
 * a drop.
 */
export function weekValues<W extends AdoptionWeek>(
  weekly: readonly W[],
  columns: readonly string[],
  keep: (w: W) => boolean = () => true,
): (number | null)[] {
  const at = new Map(weekly.map((w) => [w.week, w]))
  return columns.map((c) => {
    const w = at.get(c)
    return w && !w.partial && keep(w) ? w.total : null
  })
}

/** The newest week with all seven days on record. */
export function newestFullWeek<W extends AdoptionWeek>(weekly: readonly W[]): W | null {
  for (let i = weekly.length - 1; i >= 0; i--) if (!weekly[i]!.partial) return weekly[i]!
  return null
}
