import type { LabId, Prov, Stamp } from './common'

export type ReportedMetric =
  | 'revenue_run_rate'
  | 'revenue'
  | 'valuation'
  | 'funding'
  | 'funding_total'
export type ReportedBasis = 'reported' | 'sought' | 'projected'

/** One figure one headline states, at its earliest copy. */
export interface ReportedHeadline extends Prov {
  lab: LabId
  metric: ReportedMetric
  basis: ReportedBasis
  currency: 'USD' | 'EUR'
  amount: number
  /** The amount as the headline writes it. */
  amount_text: string
  /** The period the headline names (2028, 2026-Q3), or null: as of the report. */
  period: string | null
  title: string
  outlet: string
  /** The earliest copy of the headline. Also `source_url`. */
  url: string
  /** When GDELT first read the headline (its quarter hour, UTC). */
  published_at: string
  /** Outlets that ran the same headline. */
  outlets: number
}

/** The reported figures of one quarter, by when they were reported. */
export interface ReportedQuarter {
  quarter: string
  median: number
  low: number
  high: number
  /** Distinct headlines. */
  reports: number
}

/** One lab's figures for one metric and currency, basis `reported` only. */
export interface ReportedSeries {
  lab: LabId
  metric: ReportedMetric
  currency: 'USD' | 'EUR'
  latest: ReportedHeadline
  /** Newest first. */
  quarters: ReportedQuarter[]
}

export interface ReportedData extends Stamp {
  series: ReportedSeries[]
  /** Every basis, newest first. */
  recent: ReportedHeadline[]
  coverage: {
    /** The first quarter hour read for figures. */
    from: string
    /** GDELT files read for figures, and files still waiting to be. */
    files_read: number
    files_waiting: number
    /** Headlines kept that the judge hasn't read yet. */
    unread: number
  }
}
