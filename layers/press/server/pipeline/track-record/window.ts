// When the terminal saw an alert's change, and the window searched around it.
// Pure functions of the cited change rows and the clock.

/** The first alert day the track record covers. */
export const TRACK_RECORD_FROM = '2026-09-08'

/** Days searched either side of the saw-it time. */
export const WINDOW_DAYS = 7

const DAY_MS = 86_400_000

export interface SawIt {
  at: string
  source_url: string
  change_id: string
}

/**
 * When a row's change was first in hand. An added or modified row carries
 * the fetch that observed it. A removal counts from the run that noticed it
 * was gone: removals diffed before migration 0036 were stamped with the
 * removed row's first sighting, weeks earlier, and that migration rewrote
 * them, so reading detected_at keeps saw-it times stable either way.
 */
export function seenAt(change: Pick<SawItChange, 'change_type' | 'fetched_at' | 'detected_at'>) {
  return new Date(change.change_type === 'removed' ? change.detected_at : change.fetched_at)
}

/** When the terminal saw it: the earliest cited change row by seenAt. Ties keep the smallest id. */
export interface SawItChange {
  id: string
  change_type: string
  fetched_at: string
  detected_at: string
  source_url: string
}

export function sawIt<C extends SawItChange>(changes: readonly C[]): SawIt | null {
  let first: C | null = null
  for (const c of changes) {
    const t = seenAt(c).getTime()
    const f = first ? seenAt(first).getTime() : Infinity
    if (t < f || (t === f && first && c.id < first.id)) first = c
  }
  return first
    ? { at: seenAt(first).toISOString(), source_url: first.source_url, change_id: first.id }
    : null
}

export interface TrackWindow {
  start: string
  end: string
}

export function trackWindow(saw: string, days: number = WINDOW_DAYS): TrackWindow {
  const t = Date.parse(saw)
  return {
    start: new Date(t - days * DAY_MS).toISOString(),
    end: new Date(t + days * DAY_MS).toISOString(),
  }
}

/** A side's search row is written once the window has closed. */
export function searchState(window: TrackWindow, now: Date): 'open' | 'due' {
  return now.getTime() < Date.parse(window.end) ? 'open' : 'due'
}

/** Hours from the saw-it time to `at`: positive when the terminal saw it first. */
export function leadHours(saw: string, at: string): number {
  // `|| 0` turns a rounded -0 into 0, which prints and compares as zero.
  return Math.round((Date.parse(at) - Date.parse(saw)) / 360_000) / 10 || 0
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[mid]!
    : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10
}
