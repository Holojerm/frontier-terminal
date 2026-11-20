import type { LabId, Prov, SourceRef, Stamp } from './common'

/**
 * The dates on one report's own page. `lines` is the page's metadata cell,
 * verbatim; the two dates below are read out of it and never inferred.
 */
export interface DisclosureTimeline extends Prov {
  lines: { label: string; value: string }[]
  discovered_on: string | null
  /** The publication date the lag is measured to. */
  disclosed_on: string | null
  /**
   * printed: the page's own "Disclosure date" line. first_listed: the
   * earliest date the index has shown beside the entry, across every
   * observation this store holds. null when there is no date at all.
   */
  disclosed_basis: 'printed' | 'first_listed' | null
  /** Calendar days from discovered_on to disclosed_on; null when either is missing. */
  days_to_disclosure: number | null
}

/** One entry on a lab's own disclosure index, in the lab's own words. */
export interface DisclosureView extends Prov {
  entity_key: string
  provider: LabId
  kind: 'report' | 'notice'
  entry_id: string
  title: string
  summary: string
  model: string | null
  observed_during: string | null
  /** The date the index prints beside the entry as of the newest fetch (it moves on revision). */
  listed_on: string
  entry_url: string
  /**
   * not_applicable: a notice (its page is off-site). not_fetched: the
   * report's page has not been polled yet. title_mismatch: the page fetched
   * for this slug carries a different title, so its dates are not attached.
   */
  timeline_status: 'ok' | 'not_applicable' | 'not_fetched' | 'title_mismatch'
  timeline: DisclosureTimeline | null
}

export interface DisclosureProviderView {
  provider: LabId
  display: string
  /** no_public_feed: an audited cut (no disclosure index); no_rows: registered, nothing parsed yet. */
  feed: 'ok' | 'no_public_feed' | 'no_rows'
  /** Set for no_public_feed — the audit verdict, never a number. */
  reason: string | null
  caveat: string | null
  reports: number
  notices: number
  /** Median of days_to_disclosure over the reports that have one. */
  median_days_to_disclosure: number | null
  /** How many reports that median is taken over. */
  timed_reports: number
  sources: SourceRef[]
}

export interface DisclosuresData extends Stamp {
  providers: DisclosureProviderView[]
  /** Every entry held, newest listed first. */
  entries: DisclosureView[]
}
