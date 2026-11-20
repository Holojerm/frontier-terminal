import type { AlertSeverity } from '../terminal-tiers'
import type { ProviderId, Stamp } from './common'

/**
 * Where one side of an alert's track record stands. `matched` is the only
 * state with a time: everything else says why there is none.
 */
export type TrackRecordState =
  | 'window-open'
  | 'not-searched'
  | 'not-searchable'
  | 'no-feed'
  | 'none-found'
  | 'not-yet-rated'
  | 'no-match'
  | 'matched'

export interface TrackRecordHit {
  title: string
  outlet: string
  url: string
  /** The quarter hour GDELT read the article, or the post's own publication time. */
  published_at: string
  /** The judge's same-event rationale. */
  rationale: string
  /** The GDELT file (a search-API query before 2026-11-07) or newsroom feed it came from, and when that was read. */
  source_url: string
  fetched_at: string
}

export interface TrackRecordSide {
  state: TrackRecordState
  /** The reason for `not-searchable` or `no-feed`. */
  detail: string | null
  hit: TrackRecordHit | null
  /** Hours from the saw-it time to the hit: positive when we saw it first. */
  lead_hours: number | null
  candidates: number
  rated: number
  /**
   * Set when the search began after the window did: press before this time
   * was read before the alert existed and never matched to it, so a lead
   * here may be no lead at all. Such a side is left out of the tally.
   */
  searched_from: string | null
}

export interface TrackRecordRow {
  alert_id: string
  severity: AlertSeverity
  headline: string
  created_at: string
  providers: ProviderId[]
  /** When we saw it: the earliest cited change row (a removal counts from when we noticed it). */
  saw_at: string
  saw_source_url: string
  window_from: string
  window_to: string
  press: TrackRecordSide
  newsroom: TrackRecordSide
}

export interface TrackRecordTally {
  matched: number
  led: number
  lagged: number
  /** Same hour either way: |lead| under 0.05 h. */
  tied: number
  median_lead_hours: number | null
  not_yet_rated: number
  /** Matched sides left out of the counts above: searched only from part way through the window. */
  searched_in_part: number
}

export interface TrackRecordData extends Stamp {
  from: string
  window_days: number
  rows: TrackRecordRow[]
  press: TrackRecordTally
  newsroom: TrackRecordTally
  window_open: number
}
