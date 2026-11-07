// The shape of the reader's stored settings (app/composables/useReaderPrefs.ts
// holds the live state). Pure, so the parsing and ordering rules are tested
// without a browser.

import { isTimeZone } from './terminal-format'
import { LABS } from './terminal-lab-summary'
import type { LabId } from './terminal-types'

export const PREFS_KEY = 'ft:reader-prefs'

export interface ReaderPrefs {
  /** 'local' follows the browser; otherwise 'UTC' or an IANA zone. */
  zone: string
  clock: 'auto' | '12h' | '24h'
  dates: 'short' | 'iso'
  relative: boolean
  numbers: 'compact' | 'full'
  density: 'comfortable' | 'compact'
  /** Kept in LABS order, whatever order the reader starred them in. */
  watchlist: LabId[]
}

export const DEFAULTS: ReaderPrefs = {
  zone: 'local',
  clock: 'auto',
  dates: 'short',
  relative: true,
  numbers: 'compact',
  density: 'comfortable',
  watchlist: [],
}

// Hand-rolled rather than Zod: this ships to every browser, and seven fields
// do not need a schema library in the client bundle.
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback

/** Unknown, missing or malformed fields fall back one by one, so an old save never wipes the rest. */
export function parsePrefs(raw: unknown): ReaderPrefs {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const d = DEFAULTS
  return {
    zone:
      typeof r.zone === 'string' && (r.zone === 'local' || isTimeZone(r.zone)) ? r.zone : d.zone,
    clock: oneOf(r.clock, ['auto', '12h', '24h'], d.clock),
    dates: oneOf(r.dates, ['short', 'iso'], d.dates),
    relative: typeof r.relative === 'boolean' ? r.relative : d.relative,
    numbers: oneOf(r.numbers, ['compact', 'full'], d.numbers),
    density: oneOf(r.density, ['comfortable', 'compact'], d.density),
    watchlist: Array.isArray(r.watchlist)
      ? LABS.filter((id) => (r.watchlist as unknown[]).includes(id))
      : d.watchlist,
  }
}

/** Starred labs' rows first, the order inside each group unchanged. */
export function labsFirst<T>(
  rows: readonly T[],
  lab: (row: T) => string,
  starred: readonly LabId[],
): T[] {
  if (starred.length === 0) return [...rows]
  const on = (r: T) => (starred as readonly string[]).includes(lab(r))
  return [...rows.filter(on), ...rows.filter((r) => !on(r))]
}
