import type { LabId, Prov, SourceRef, Stamp } from './common'

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
  /** Set for no_public_feed — the audit verdict, never a number. */
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
  /** Earliest started_at held for this provider — where the count's history begins. */
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
}
