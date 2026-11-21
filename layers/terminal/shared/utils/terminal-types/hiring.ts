import type {
  ArchiveReach,
  LabId,
  SourceRef,
  Stamp,
} from '#layers/core/shared/utils/terminal-types/common'

export interface DeptCount {
  department: string
  count: number
}

export type HiringSource = SourceRef

export interface HiringProviderView {
  provider: LabId
  display: string
  /** no_public_feed: an audited cut; no_rows: feed registered, nothing parsed yet. */
  feed: 'ok' | 'no_public_feed' | 'no_rows'
  /** Set for no_public_feed — the audit verdict, never a number. */
  reason: string | null
  total: number
  departments: DeptCount[]
  /** Travels with the data, e.g. the xAI SpaceXAI entity blend. */
  caveat: string | null
  /** Distinct company_name values observed on the rows — the blend evidence. */
  company_names: string[]
  sources: HiringSource[]
}

export interface HiringData extends Stamp {
  providers: HiringProviderView[]
}

export interface DeptSeries {
  department: string
  /** Open roles at the end of each date in the provider's `dates`. */
  series: number[]
}

/**
 * One department cluster (sources.yaml `department_clusters`) on one board:
 * the departments whose names matched, and their summed open roles per day
 * on the provider's `dates`. `now`/`then` mirror HiringCompare's instant.
 */
export interface ClusterSeries {
  id: string
  label: string
  /** The board's own department labels that matched, largest today first — what was summed, visibly. */
  departments: DeptCompare[]
  series: number[]
  now: number
  /** null until the series has two points. */
  then: number | null
  /** The comparison instant, as HiringCompare.at. */
  then_at: string | null
}

export interface DeptCompare {
  department: string
  then: number
  now: number
}

/**
 * Open roles now against an earlier instant: `window_days` back, or the
 * start of the series when that is younger — `days` says which it was.
 */
export interface HiringCompare {
  at: string
  days: number
  total_then: number
  total_now: number
  departments: DeptCompare[]
}

/**
 * Open roles per day, reconstructed by undoing the change log backwards
 * from the current entity set (layers/terminal/server/utils/terminal-history.ts). The
 * series starts at the provider's earliest snapshot; roles that opened or
 * closed between the last imported poll and this store's baseline are not
 * in the log and are carried as they stand today.
 */
export interface HiringHistoryProvider {
  provider: LabId
  display: string
  feed: 'ok' | 'no_public_feed' | 'no_rows'
  reason: string | null
  caveat: string | null
  /** UTC dates (YYYY-MM-DD), oldest first; a point is the state at the end of that day. */
  dates: string[]
  total: number[]
  /** Every department seen in the window, largest today first. */
  departments: DeptSeries[]
  /** Named department clusters from sources.yaml (the physical-infrastructure buildout signal), summed over the matched departments. */
  clusters: ClusterSeries[]
  compare: HiringCompare | null
  /** Earliest snapshot of the provider's job board — where the series starts. */
  series_from: string | null
  /** This store's first (baseline) poll of the board; the log before it is imported history. */
  baseline_at: string | null
  /** Earliest snapshot of the board's /departments join, where one exists: rows before it carry no department. */
  join_from: string | null
  sources: HiringSource[]
  /** The Internet Archive's copies of the lab's board before we read it live, oldest first. */
  archived: ArchivedHiringPoint[]
  /** Where the archived board differs from the live one (another board, another entity mix). */
  archive_caveat: string | null
}

/**
 * One Internet Archive copy of a lab's job board, read into the counts the
 * live lane derives: `at` is when the Archive saw the board (event time);
 * fetched_at is when we read the copy back, long after (knowledge time).
 */
export interface ArchivedHiringPoint {
  at: string
  basis: 'archived'
  /** wayback:<era>, the board and window the copy belongs to (archive/hiring-eras.ts). */
  source_id: string
  /** Open roles on the whole board. */
  total: number
  /** Every department with its count, summing to total; null when the copy states only the total. */
  departments: ArchivedDepartmentCount[] | null
  /** sources.yaml department_clusters over each row's live department (`departments`: the labels printed); null with departments. */
  clusters: { id: string; label: string; open_roles: number; departments: string[] }[] | null
  source_url: string
  fetched_at: string
}

export interface ArchivedDepartmentCount {
  /** The live department it files under: the label, unless the board's own id ties it to a live one. */
  department: string
  /** As the board printed it then. */
  label: string
  open_roles: number
}

export interface HiringHistoryData extends Stamp {
  window_days: number
  providers: HiringHistoryProvider[]
  /** How far each lab's hiring history reaches: the Internet Archive backfill, then the live board. */
  reach: ArchiveReach[]
  /** What an archived point is, and event time against knowledge time. */
  archive_method: string
  /** The change rows the series rests on: how many, and the span they cover. */
  log: { changes: number; from: string | null; to: string | null }
}
