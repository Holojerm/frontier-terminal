import type { LabId, Prov, SourceRef, Stamp } from '../../../core/shared/types/common'

/** One posted incident, as the vendor's own feed states it. */
export interface IncidentView extends Prov {
  entity_key: string
  source_id: string
  provider: LabId
  incident_id: string
  title: string
  /** Vendor vocabulary, verbatim: Statuspage none/minor/major/critical; Google low/medium/high.
   * null where the feed publishes none (Anthropic's Atom history): never inferred. */
  impact: string | null
  status: string
  started_at: string
  /** null while the incident is open. */
  resolved_at: string | null
  /** Statuspage component names / Google affected_products titles. */
  components: string[]
  incident_url: string
}

export interface IncidentProviderView {
  provider: LabId
  display: string
  /** no_public_feed: an audited cut; no_rows: feed registered, nothing parsed yet. */
  feed: 'ok' | 'no_public_feed' | 'no_rows'
  /** Set for no_public_feed: the audit verdict, never a number. */
  reason: string | null
  /** The audit's caveat for the feed (e.g. Google's product filter), in its own words. */
  caveat: string | null
  /**
   * Where this lab's windows count back from: its feed's last successful read
   * (its newest snapshot if never read, the payload's window_to with neither).
   * Null for an audited cut.
   */
  window_to: string | null
  /** Incidents started inside the window_days to window_to. */
  last_window: number
  /** Incidents started in the window_days before that. */
  prior_window: number
  /** Currently open (resolved_at null), newest first. */
  open: IncidentView[]
  /** Earliest started_at held for this provider: where the count's history begins. */
  coverage_from: string | null
  sources: SourceRef[]
}

export interface IncidentsData extends Stamp {
  /** The freshest lab's window_to, or computed_at before any read: where the incident list counts back from. Each lab's counts use its own. */
  window_to: string
  window_days: number
  history_days: number
  providers: IncidentProviderView[]
  /** Every incident started inside history_days, all providers, newest first. */
  incidents: IncidentView[]
  /** Null until the backfill (scripts/wayback-backfill.ts --axis status) has run. */
  archived: IncidentArchiveView | null
}

/** One lab's incidents per month from the Internet Archive's copies of its status feed. */
export interface IncidentArchiveLab {
  provider: LabId
  display: string
  /** Per IncidentArchiveView.months: incidents that started that month in any copy; null where no copy covers any of it. */
  counts: (number | null)[]
  /** Per month, the share of it (0 to 1) inside some copy's reach, from covers_from to the moment the Archive took it. */
  covered: number[]
  /** Copies read and skipped (archive_captures, axis status). */
  copies: number
  skipped: number
  /** Distinct incidents held, all months. */
  incidents: number
  first_copy: string | null
  last_copy: string | null
  /** Stretches of at least a day before live_from that no copy reaches. */
  holes: { from: string; until: string }[]
  /** The live lane's first read (YYYY-MM-DD). The archived months stop at the month before. */
  live_from: string
  /** Each feed read, and the Internet Archive's list of its copies. */
  feeds: { url: string; archive_url: string }[]
}

/** Incident history from before the live status lanes, read from the Internet Archive. */
export interface IncidentArchiveView {
  /** YYYY-MM, ascending, from the first month any copy reaches to the last month before a live lane began. */
  months: string[]
  labs: IncidentArchiveLab[]
  /** Stretches with no copy, and why. */
  gaps: { provider: LabId; display: string; from: string; until: string; reason: string }[]
  /** Labs with a live feed and no archived history we read, and why. */
  not_covered: { provider: LabId; display: string; reason: string }[]
  method: string
}
