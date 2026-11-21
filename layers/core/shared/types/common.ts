export interface Prov {
  source_url: string
  /** ISO 8601 with timezone, exactly as stored. */
  fetched_at: string
  /**
   * On a citation that names its source (source_id): set when every check of
   * that source has failed for six hours or more, to when the failures began.
   * The datum beside it is the last one we read. Absent on a healthy source
   * and on a payload read with as_of.
   */
  failing_since?: string
}

/** A recipe-read figure's citation: which recipe, labelled for a reader. */
export interface RecipeCitation extends Prov {
  recipe_id: string
  label: string
}

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'meta'
  | 'mistral'
  | 'deepseek'
  | 'alibaba'
  | 'moonshot'
  | 'other'
export type LabId = Exclude<ProviderId, 'other'>

export type SourceAxis =
  | 'pricing-catalog'
  | 'pricing-cross-check'
  | 'hiring'
  | 'sec'
  | 'revenue'
  | 'status'
  | 'disclosures'
  | 'demand-share'
export type SourceRole = 'primary' | 'join' | 'cross-check' | 'sec' | 'status'
/**
 * What a paid licence could cover, per sources.yaml `rights:`. `ours`: facts
 * the publisher states about itself, read under terms and a robots.txt that
 * allow it, so the compilation is ours to license. `upstream`: someone else's
 * dataset under its own licence (CC BY and the like), which travels with it.
 * `restricted`: facts the publisher states about itself on a public page its
 * robots.txt doesn't close, where its site terms restrict automated reading
 * or weren't found. A licence can cover our compilation of the rows with that
 * disclosed, never the saved pages. `not-cleared`: no stated licence, a
 * publisher's own words, an unreadable robots.txt, or terms that condition
 * reuse, so it stays on the free site and out of any paid offer.
 */
export const SOURCE_RIGHTS = ['ours', 'restricted', 'upstream', 'not-cleared'] as const
export type SourceRights = (typeof SOURCE_RIGHTS)[number]
export type RunStatus = 'ok' | 'unchanged' | 'failed' | 'baseline' | 'skipped' | 'absent'

/** Where the numbers on a page stand in time. Every payload carries one. */
export interface Stamp {
  /** Newest source_runs.started_at: the poll tick this data reflects; null before the first tick. */
  as_of: string | null
  /** When this payload was computed (it may then sit in the cache for up to five minutes). */
  computed_at: string
}

/** A source cited beside a number: which feed, where, and when it was read. */
export interface SourceRef extends Prov {
  source_id: string
  label: string
}

export interface ArchiveReach {
  provider: LabId
  archived_from: string | null
  archived_until: string | null
  /** Captures read and stored, and captures skipped because they could not be read confidently. */
  archived_parsed: number
  archived_skipped: number
  live_from: string | null
  /** Stretches before live_from with no readable capture, and why. */
  gaps: { from: string; until: string; reason: string }[]
  /** Set when the lab's archived pages are not read at all. */
  not_covered: string | null
}

/** One field of an entity that a change moved, as the alerts feed and its exports show it. */
export interface FieldDiff {
  field: string
  before: string | null
  after: string | null
}
