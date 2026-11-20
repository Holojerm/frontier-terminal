import type { LabId, Prov, Stamp } from './common'
import type { ReportedHeadline, ReportedMetric } from './reported'
import type { TrackRecordTally } from './track-record'

/**
 * matched: within the tolerance of a figure a later filing printed.
 * missed: the headline named the period and the filed figure is further off.
 * restated: published on or after the day the figure was filed, so not scored.
 * open: no filing has printed a figure it can be checked against.
 */
export type GroundTruthState = 'matched' | 'missed' | 'restated' | 'open'

/** A filed revenue figure for one period, at the filing that first printed it. */
export interface GroundTruthFiled extends Prov {
  start: string
  end: string
  days: number
  /** 2025, Q3 2026, First half of 2026. */
  label: string
  val: number
  /** The filing date of the first filing that printed it: the day it became public. */
  first_filed: string
  form: string
  accession_no: string
  filing_url: string
  unaudited: boolean
  /** The two filed periods a figure no filing prints was subtracted from: the longer, then the shorter. */
  derived_from: { start: string; end: string; val: number; filing_url: string }[] | null
}

/** One press headline's revenue figure, checked against the filings. */
export interface GroundTruthReport extends Prov {
  lab: LabId
  amount: number
  amount_text: string
  /** The period the headline names, or null. */
  period: string | null
  title: string
  outlet: string
  url: string
  /** When GDELT first read the headline (its quarter hour, UTC). */
  published_at: string
  /** When we stored it. After the filing for a headline read back from GDELT's archive. */
  found_at: string
  outlets: number
  state: GroundTruthState
  /** stated: the headline named the period. nearest: the closest filed figure not yet public. Null when nothing was compared. */
  matched_by: 'stated' | 'nearest' | null
  /** The filed period it was compared with. For an open report, the nearest one, shown and not scored. */
  filed_label: string | null
  filed_val: number | null
  /** (reported − filed) / filed, in percent. */
  error_pct: number | null
  /** Days from the report to the filing day. Null unless matched or missed. */
  lead_days: number | null
  /** Whether we had stored the headline before the filing day. Null unless matched or missed. */
  held_before_filing: boolean | null
}

/** One filed figure and every report scored against it. */
export interface GroundTruthResolution {
  lab: LabId
  filed: GroundTruthFiled
  /** Matched and missed reports, earliest first. */
  reports: GroundTruthReport[]
  /** Days from the earliest report to the filing day. */
  lead_days: number
  median: number
  low: number
  high: number
  /** The median report against the filed figure, in percent. */
  error_pct: number
  /** Reports we had stored before the filing day. */
  held: number
}

/** Reported figures nothing filed can score yet. */
export interface GroundTruthWaiting {
  lab: LabId
  metric: ReportedMetric
  currency: 'USD' | 'EUR'
  reports: number
  latest: ReportedHeadline
  /** no-filing: the lab hasn't filed. not-in-filings: we read no filed figure of this kind. */
  reason: 'no-filing' | 'not-in-filings'
}

export interface GroundTruthTally {
  /** Filed figures with at least one earlier report. */
  periods: number
  /** Reports scored: matched plus missed. */
  reports: number
  missed: number
  median_abs_error_pct: number | null
  /** Median over the filed figures of the earliest report's lead. */
  median_lead_days: number | null
  held: number
  restated: number
  open: number
}

// A deal size a headline states, against what the other company filed.

export type DealMetric = 'commitment' | 'investment' | 'financing' | 'commitment_total'

/**
 * no-filer: we read no filings from the other company.
 * not-filed: its filings state no figure for this.
 * different-measure: they state one that measures something else.
 */
export type DealUnsettledReason = 'no-filer' | 'not-filed' | 'different-measure'

/** A filed figure a deal report was compared with, at the filing that first printed it. */
export interface GroundTruthDealFiled extends Prov {
  /** The company whose filing printed it. */
  filer: string
  /** Null for a lab's own prospectus. */
  ticker: string | null
  label: string
  /** Q2 2026, or the balance date. */
  period: string
  value: number
  first_filed: string
  form: string
  accession_no: string
  filing_url: string
}

/** One press headline's deal size, checked against the filings. */
export interface GroundTruthDeal extends Prov {
  lab: LabId
  metric: DealMetric
  /** The other company as the headline names it. Null for a lab's total commitments. */
  counterparty: string | null
  currency: 'USD' | 'EUR'
  amount: number
  amount_text: string
  title: string
  outlet: string
  url: string
  published_at: string
  found_at: string
  outlets: number
  /** unsettled: no filed figure measures what the headline states. The rest as for revenue. */
  state: GroundTruthState | 'unsettled'
  reason: DealUnsettledReason | null
  /** Why no filed figure settles it. Null unless unsettled. */
  why: string | null
  /** The filed figure it was compared with. Null when open or unsettled. */
  filed: GroundTruthDealFiled | null
  /** (reported − filed) / filed, in percent. */
  error_pct: number | null
  lead_days: number | null
  held_before_filing: boolean | null
}

/** A filed figure the deal check reads, and whether a headline's deal size can be scored against it. */
export interface GroundTruthDealMeasure {
  lab: LabId
  filer: string
  metric: DealMetric
  label: string
  /** added: the amount added in one quarter. total: a balance. Null when it isn't comparable. */
  compares: 'added' | 'total' | null
  /** Why it isn't comparable. Null when it is. */
  why: string | null
}

export interface GroundTruthDealTally {
  /** Deal reports the judge labeled as fact, in dollars or euros. */
  reports: number
  /** Matched plus missed. */
  scored: number
  missed: number
  restated: number
  open: number
  unsettled: number
  held: number
  median_abs_error_pct: number | null
}

export interface GroundTruthDeals {
  /** Newest first. */
  reports: GroundTruthDeal[]
  tally: GroundTruthDealTally
  measures: GroundTruthDealMeasure[]
  /** Stored headlines with a deal word that the judge hasn't read for deals yet. */
  unread: number
  /** When the first deal was labeled, or null: none has been. */
  first_labeled_at: string | null
}

// Capex guidance an earnings release prints, against the capex filed for that year.

/**
 * met: the filed figure is inside the range, or within the tolerance of a single figure.
 * above, below: it is outside. open: the year isn't filed yet.
 * unsettled: we don't read the filed line the guidance covers.
 */
export type GuidanceState = 'met' | 'above' | 'below' | 'open' | 'unsettled'

/** The filed capex for a fiscal year, at the filing that first printed it. */
export interface GroundTruthActual extends Prov {
  value: number
  /** The filed lines it is the sum of, one or more. */
  parts: { label: string; value: number }[]
  first_filed: string
  form: string
  accession_no: string
  filing_url: string
}

/** One capex figure one earnings release printed for a fiscal year. */
export interface GroundTruthGuidance extends Prov {
  ticker: string
  filer: string
  fiscal_year: number
  /** 2025, or Fiscal 2026 (June 2025 to May 2026). */
  period: string
  start: string
  end: string
  /** In US dollars. Equal for a single figure. */
  low: number
  high: number
  /** The release's sentence. */
  sentence: string
  /** The day the release was filed, as exhibit 99.1 of this 8-K. */
  filed: string
  accession_no: string
  filing_url: string
  state: GuidanceState
  actual: GroundTruthActual | null
  /** How far the filed figure is outside the range, in percent of the nearer end. 0 inside it. For a single figure, (filed − guided) / guided. */
  error_pct: number | null
  /** Days from the release to the filing that printed the year. */
  lead_days: number | null
}

/** What one filer's releases print, and what we compare it with. */
export interface GroundTruthGuidanceFiler {
  ticker: string
  filer: string
  /** Earnings releases read, and those that print a capex figure. */
  releases_read: number
  releases_with_figure: number
  /** What the guidance is compared with. Null when it isn't scored. */
  compared_with: string | null
  /** Why this filer's guidance isn't scored, or isn't there. Null when it is scored. */
  gap: string | null
}

export interface GroundTruthGuidanceTally {
  figures: number
  /** Met, above or below. */
  scored: number
  met: number
  above: number
  below: number
  open: number
  unsettled: number
  /** Median distance outside the range or from the figure, over the scored ones that weren't met. */
  median_miss_pct: number | null
}

export interface GroundTruthGuidanceData {
  /** Newest release first. */
  rows: GroundTruthGuidance[]
  tally: GroundTruthGuidanceTally
  filers: GroundTruthGuidanceFiler[]
  /** Releases filed before this day aren't read. */
  since: string
}

export interface GroundTruthData extends Stamp {
  /** A report matches the nearest filed figure within this many percent. */
  tolerance_pct: number
  /** Press reports of a deal's size against the figure the other company filed. */
  deals: GroundTruthDeals
  /** Capex guidance from earnings releases against the capex filed for the year. */
  guidance: GroundTruthGuidanceData
  /** Newest filing first. */
  resolutions: GroundTruthResolution[]
  /** Unscored revenue reports for labs that have filed, newest first. */
  open: GroundTruthReport[]
  waiting: GroundTruthWaiting[]
  tally: GroundTruthTally
  /** The first headline we stored, or null: reports published before it were read back. */
  first_stored_at: string | null
  /** The alert track record's totals (/api/track-record has every row). */
  alerts: {
    from: string
    window_days: number
    rated: number
    window_open: number
    press: TrackRecordTally
    newsroom: TrackRecordTally
  }
}
