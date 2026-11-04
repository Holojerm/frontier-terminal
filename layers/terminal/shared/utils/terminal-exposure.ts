// The hyperscaler exposure payload (GET /api/exposure, the /exposure page,
// the get_exposure MCP tool): quarterly series built from the filed XBRL facts
// of five public filers. Shared so the page and the server agree on one shape.

import type { Prov } from './terminal-types'

export type ExposureGroup = 'capex' | 'rpo' | 'openai' | 'anthropic'

export type ExposureTicker = 'MSFT' | 'GOOGL' | 'AMZN' | 'META' | 'ORCL'

/** One filing a value was read from. */
export interface ExposureFiling {
  accession_no: string
  form: string
  filed: string
  /** EDGAR's filing index for the accession. */
  filing_url: string
}

/** One quarter (a flow) or one balance date, as the newest filing reported it. */
export interface ExposurePoint extends ExposureFiling, Prov {
  /** Null for a balance. */
  start: string | null
  end: string
  value: number
  /**
   * True when the quarter is a year-to-date figure less the one before it
   * (a 10-Q's six months less its three, a 10-K's year less nine months).
   * `less` names the figure taken away.
   */
  derived: boolean
  less: (ExposureFiling & { start: string | null; end: string; value: number }) | null
  /**
   * A flow's length in months: 3 for a quarter. Longer where the filer tags
   * no quarter for that end (a nine-month figure). Null for a balance.
   */
  months: number | null
}

/** A value a later filing replaced with a different one. */
export interface ExposureSuperseded extends ExposureFiling, Prov {
  start: string | null
  end: string
  value: number
  /** The accession whose value replaced it. */
  replaced_by: string
}

export interface ExposureSeries {
  id: string
  ticker: ExposureTicker
  /** The filer's name, e.g. Microsoft. Every series is the filer's number. */
  filer: string
  group: ExposureGroup
  /** Series drawn on one chart share a chart id. */
  chart: string
  label: string
  /** The XBRL concept and the context's dimensions ('' for none) the series reads. */
  concept: string
  dims: string
  /** flow: per quarter. balance: at each period end. */
  kind: 'flow' | 'balance'
  unit: string
  note: string | null
  /** Oldest first. */
  points: ExposurePoint[]
  superseded: ExposureSuperseded[]
}

export interface ExposureFilerView {
  ticker: ExposureTicker
  name: string
  cik: string
  /** The company-facts document the non-dimensional series come from. */
  source_url: string
  /** True when each 10-Q/10-K's own instance is read too (dimensional facts). */
  instances: boolean
  fiscal_year_end: string
  caveat: string | null
  /** The newest read of either document, or null before the first. */
  last_read_at: string | null
  /** Accessions whose instance was read. */
  instances_read: number
}

/** A figure an analyst would look for that the filings don't tag. */
export interface ExposureGap {
  id: string
  group: ExposureGroup
  ticker: ExposureTicker
  title: string
  reason: string
}

export interface ExposureData {
  as_of: string | null
  computed_at: string
  /** How a point-in-time request is answered. */
  rule: string
  filers: ExposureFilerView[]
  series: ExposureSeries[]
  gaps: ExposureGap[]
}
