// The /api/reliability payload and the rules it is computed by: what a
// due-diligence reviewer reads on /data#reliability. Shared so the page states
// the same thresholds the server applies.

import type { ProviderId, SourceAxis } from './terminal-types'

/** The two look-back windows, in UTC days counting today. */
export const RELIABILITY_DAYS = { short: 30, long: 90 } as const

/** A run that answered: ok, unchanged, baseline, or absent (the page isn't there, which is itself the reading). */
export const GOOD_RUN_STATUSES = ['ok', 'unchanged', 'baseline', 'absent'] as const

/**
 * The rules that alert on a filing with no model in the loop, in the same
 * check that saw it, so the alert's created_at is when we raised it.
 */
export const DETECTION_RULES = [
  's1-floor',
  'cik-resolved',
  'periodic-floor',
  'prospectus-floor',
] as const

/** EDGAR holds a filing accepted after 5:30 p.m. Eastern until 6:00 a.m. Eastern on its filing date. */
export const EDGAR_RELEASE_HOUR_ET = 6

/**
 * How often the site says each kind of data is checked (/about#latency), and
 * how late a check can be before we count the gap. `scopes` are the poll
 * scopes whose ticks refresh it.
 */
export const FRESHNESS_LANES = [
  {
    id: 'sec',
    label: 'SEC filings and model catalogs',
    scopes: ['edgar', 'survey'],
    stated_minutes: 30,
    grace_minutes: 15,
  },
  {
    id: 'all',
    label: 'Every source',
    scopes: ['survey'],
    stated_minutes: 360,
    grace_minutes: 30,
  },
] as const

export type FreshnessLaneId = (typeof FRESHNESS_LANES)[number]['id']

export interface RunTally {
  runs: number
  good: number
}

export interface RunGap {
  minutes: number
  /** The last good run before the gap. */
  from: string
  /** The good run that ended it, or null while it is still open. */
  to: string | null
}

export interface SourceReliability {
  /** A registered source's id, or a template's id for a group of derived sources. */
  source_id: string
  label: string
  provider: ProviderId | 'all'
  axis: SourceAxis
  url: string
  /** Derived sources folded into this row (per-model pages, per-filing indexes); 0 for a registered source. */
  members: number
  /** How often we say we check it, in minutes. */
  stated_minutes: number
  /** Null while the rollup is still building: the window isn't fully counted yet. */
  short: RunTally | null
  long: RunTally | null
  longest_gap: RunGap | null
  last_good_at: string | null
}

export interface StalePeriod {
  /** When the data passed its stated age: the last check plus the stated interval. */
  from: string
  /** The next check, or null while it is still overdue. */
  to: string | null
  minutes: number
}

export interface FreshnessLane {
  id: FreshnessLaneId
  label: string
  stated_minutes: number
  grace_minutes: number
  /** The first check in the window. */
  from: string | null
  checks: number
  stale_minutes: number
  /** Newest first. */
  periods: StalePeriod[]
}

export interface FilingDetection {
  accession_no: string
  cik: string
  form: string | null
  /** The first rule alert that cited this filing. */
  alert_id: string
  rule: string
  headline: string
  alerted_at: string
  /** EDGAR's acceptance time (UTC); null when no stored payload listed it. */
  accepted_at: string | null
  filing_date: string | null
  /** When EDGAR made it public: the acceptance time, or 6:00 a.m. Eastern on the filing date for an after-hours filing. */
  released_at: string | null
  minutes_from_acceptance: number | null
  minutes_from_release: number | null
  /** Where the acceptance time was read: the stored submissions JSON or filing index page. */
  basis: 'submissions' | 'filing-index' | null
  source_url: string | null
  fetched_at: string | null
  /** The filing's EDGAR index page. */
  filing_url: string
}

export interface LatencySummary {
  median_minutes: number | null
  worst_minutes: number | null
}

export interface DeployCheck {
  run_id: string
  head_sha: string
  status: string
  conclusion: string | null
  created_at: string
  updated_at: string
  html_url: string
}

export interface ReliabilityData {
  as_of: string | null
  computed_at: string
  days: typeof RELIABILITY_DAYS
  /**
   * Set while the daily rollup is more than an hour behind now (a fresh
   * deploy backfilling history). Gaps, stale periods and window tallies are
   * withheld until it catches up; started is the first day it holds.
   */
  building: { rolled_through: string | null; started: string | null } | null
  sources: {
    /** Every run before this instant is counted (rollup_state). */
    rolled_through: string | null
    /** The first day the rollup holds inside the long window. */
    first_day: string | null
    rows: SourceReliability[]
  }
  freshness: FreshnessLane[]
  detection: {
    rules: readonly string[]
    /** The first alert counted. */
    from: string | null
    rows: FilingDetection[]
    acceptance: LatencySummary
    release: LatencySummary
    missing: number
  }
  deploys: {
    workflow_url: string
    /** The GitHub API page the rows were read from, and when. */
    source_url: string
    fetched_at: string | null
    from: string | null
    rows: DeployCheck[]
    tally: { success: number; failure: number; cancelled: number; other: number; running: number }
    /** The commit this deploy runs (/api/status build.sha). */
    build_sha: string | null
  }
  corrections: {
    count: number
    latest: { on: string; area: string; what: string; fix: string } | null
    url: string
  }
}

/** Minutes from `from` to `to`, to one decimal. */
export function minutesBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 6000) / 10
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[mid]!
    : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10
}

/** "31 min", "10.5 h", "3.2 days": a duration a reader can take in at a glance. */
export function durationLabel(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} min`
  const hours = minutes / 60
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`
  return `${Math.round((hours / 24) * 10) / 10} days`
}
