import type { LabId, Prov, SourceRef, Stamp } from '#layers/core/shared/utils/terminal-types/common'

/**
 * One reported period: the filer's own XBRL value for one revenue tag over
 * start..end, from the filing that reported it. When a later filing
 * restates the same period, `superseded_by` names it and the newest
 * filing's value is the one the period table shows.
 */
export interface RevenuePeriod extends Prov {
  entity_key: string
  start: string
  end: string
  /** Calendar days in the period — ~91 reads as a quarter, ~182 a half, ~365 a year. */
  days: number
  fy: number | null
  fp: string | null
  form: string
  filed: string
  accession_no: string
  /** EDGAR's filing index for the accession — composed from cik + accession, verified to resolve. */
  filing_url: string
  /** The XBRL tag, or for a prospectus value the statement's own row label. */
  tag: string
  val: number
  /** SEC's calendar frame when the fact is the canonical one for it (CY2026Q2). */
  frame: string | null
  /** xbrl: tagged data. prospectus: read off the statement printed in a registration filing that tags no financials. */
  basis: 'xbrl' | 'prospectus'
  /** An interim period from a registration statement, which prints it unaudited. */
  unaudited: boolean
}

export interface RevenueFilerView {
  /** The ticker sources.yaml tags; null for a filer resolved from its own S-1 (no ticker until it lists). */
  ticker: string | null
  cik: string
  /** As the filer's company-facts payload names itself. */
  entity_name: string | null
  /** issuer: the lab files for itself. parent: a public parent consolidates it, and the series is the parent's. */
  relation: 'issuer' | 'parent'
  /** The parent's segment member the series is read on (goog:GoogleCloudMember); null for a consolidated series. */
  segment: string | null
  /** The segment as a reader names it (Google Cloud); null with `segment`. */
  segment_label: string | null
  /** How the filer was tagged: the audited file, or resolved at poll time from a registration filing (pending_filers). */
  tagged_by: 'sources.yaml' | 'resolved'
  /** For a resolved filer: the filing the CIK was read from. */
  resolved_from: {
    form: string
    accession_no: string
    file_date: string
    filing_url: string
  } | null
  source_id: string
  /** The audit's caveat for the feed — for a parent, the words that say whose revenue this is. */
  caveat: string | null
}

export interface RevenueProviderView {
  provider: LabId
  display: string
  /** none: no audited disclosure on file, nothing shown. parent / issuer: a tagged filer with facts. no_rows: tagged, nothing parsed yet. */
  disclosure: 'none' | 'parent' | 'issuer' | 'no_rows'
  filer: RevenueFilerView | null
  /** Newest-period first; only the newest filing's value per (start, end). */
  periods: RevenuePeriod[]
  /** Periods dropped because a later filing restated them, newest first. */
  superseded: RevenuePeriod[]
  /** Tags present in the filer's facts, in preference order. */
  tags: string[]
  sources: SourceRef[]
}

export interface RevenueData extends Stamp {
  providers: RevenueProviderView[]
  /** The rule this panel obeys, stated once for the page. */
  rule: string
}
