// What may be reused here, and under what terms.
//
// Three different things get licensed on a site like this one, and collapsing
// them into a single "license" line is the easy way to say something false:
//
//   * The code is MIT. That is the repo's license and nothing else's.
//   * The compilation — which rows exist, keyed, timestamped, and joined — and
//     the numbers we derive are this site's own work. They are split by age:
//     the trailing LICENSE_WINDOW_DAYS are CC BY 4.0, older rows CC BY-NC 4.0.
//   * The facts are not ours to license. A price on Anthropic's pricing page
//     belongs to Anthropic; a filing belongs to EDGAR. Every row carries the
//     URL it was read from precisely so a reader can go to the owner.
//
// CC BY 4.0 on the recent window is a constrained choice rather than a taste.
// One tracked source states a license of its own — the OpenRouter rankings
// feed is CC BY 4.0 and requires a specific attribution string, which the
// demand-share page prints verbatim from sources.yaml. Upstream data like that
// keeps its own license in every window; the NC term covers only what is ours.
//
// The split took effect on LICENSE_SPLIT_EFFECTIVE (docs/thesis-engine.md ›
// Revisions). A CC BY grant can't be withdrawn from what was already released
// under it, so a row we first published before that day stays CC BY however
// old it gets. rowLicense applies both rules.

export interface LicenseRef {
  /** SPDX identifier where one exists. */
  id: string
  /** Full name, for a schema.org `name`. */
  name: string
  /** What a sentence calls it. */
  short: string
  url: string
}

/** The recent window of the compilation: the tables, the change log, the alerts, the exports. */
export const DATA_LICENSE: LicenseRef = {
  id: 'CC-BY-4.0',
  name: 'Creative Commons Attribution 4.0 International',
  short: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
}

/** The compilation and derived numbers older than the window, first published on or after the split. */
export const HISTORY_LICENSE: LicenseRef = {
  id: 'CC-BY-NC-4.0',
  name: 'Creative Commons Attribution-NonCommercial 4.0 International',
  short: 'CC BY-NC 4.0',
  url: 'https://creativecommons.org/licenses/by-nc/4.0/',
}

/** The code that produces it. */
export const CODE_LICENSE: LicenseRef = {
  id: 'MIT',
  name: 'MIT License',
  short: 'MIT',
  url: 'https://opensource.org/license/mit',
}

/** How many trailing days stay CC BY 4.0. */
export const LICENSE_WINDOW_DAYS = 90

/** The UTC day the age split took effect. Rows first published before it stay CC BY. */
export const LICENSE_SPLIT_EFFECTIVE = '2026-11-04'

/** The bulk-export query parameter that opts into rows older than the window. */
export const HISTORY_PARAM = 'history'

/**
 * The first UTC day inside the window, `YYYY-MM-DD`. A stamp or date compares
 * against it as a string: `2026-08-06T10:00:00Z >= 2026-08-06`.
 */
export function licenseWindowStart(now: Date = new Date()): string {
  return new Date(now.getTime() - LICENSE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
}

/**
 * One row's license: CC BY when it is dated inside the window or we first
 * published it before the split; CC BY-NC otherwise. `dated` is the row's
 * own date (its period end, the event, or when we read it), `published` when
 * the row first appeared here.
 */
export function rowLicense(
  dated: string | null,
  published: string | null,
  windowStart: string,
): LicenseRef {
  if (dated === null || dated >= windowStart) return DATA_LICENSE
  if (published !== null && published < LICENSE_SPLIT_EFFECTIVE) return DATA_LICENSE
  return HISTORY_LICENSE
}

/** The `license` field every API response carries: the split, with the day the window starts today. */
export interface LicenseSplit {
  recent: { id: string; url: string; days: number; from: string }
  older: { id: string; url: string; published_from: string }
  /** Where the full terms are, as a path on this site. */
  terms: string
  note: string
}

export const LICENSE_SPLIT_NOTE =
  `Our compilation and derived numbers dated on or after recent.from are ${DATA_LICENSE.short}. ` +
  `Older ones are ${HISTORY_LICENSE.short}, except what we first published before ${LICENSE_SPLIT_EFFECTIVE}, which stays ${DATA_LICENSE.short}. ` +
  'Upstream data keeps its own license, and the facts belong to their publishers. ' +
  'Commercial use of the full history needs a paid license (/contact).'

export function licenseSplit(now: Date = new Date()): LicenseSplit {
  return {
    recent: {
      id: DATA_LICENSE.id,
      url: DATA_LICENSE.url,
      days: LICENSE_WINDOW_DAYS,
      from: licenseWindowStart(now),
    },
    older: {
      id: HISTORY_LICENSE.id,
      url: HISTORY_LICENSE.url,
      published_from: LICENSE_SPLIT_EFFECTIVE,
    },
    terms: '/license',
    note: LICENSE_SPLIT_NOTE,
  }
}

/**
 * The payload with the data license beside it (`license`, licenseSplit): the
 * split by age, with today's window start. Every terminal API response and
 * MCP tool result goes through this. An array or null passes through.
 */
export function withLicense<T>(payload: T, now: Date = new Date()): T {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload
  return { ...payload, license: licenseSplit(now) }
}

/**
 * The label on an `as_of` payload's data (point_in_time.license): CC BY-NC
 * when the instant is older than the window, CC BY otherwise. The payload's
 * `license` field says which rows the NC label doesn't reach.
 */
export function asOfLicense(at: string, now: Date = new Date()): string {
  return at < licenseWindowStart(now) ? HISTORY_LICENSE.id : DATA_LICENSE.id
}

/**
 * The attribution a reuser owes, with the site's own name filled in. Rendered
 * on /license and emitted in /llms.txt so the string a reuser copies is the
 * string we asked for, not one they composed.
 */
export function attributionLine(
  appName: string,
  appUrl: string,
  license: LicenseRef = DATA_LICENSE,
): string {
  return `Source: ${appName} (${appUrl}). Licensed under ${license.short}.`
}
