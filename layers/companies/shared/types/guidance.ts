import type { Prov } from '../../../core/shared/types/common'

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
