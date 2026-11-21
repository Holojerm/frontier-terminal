// What management guided on earnings calls, scored against what the company
// filed later (GET /api/call-guidance, the /ground-truth panel, the
// get_call_guidance MCP tool). Only scored figures, quotes of at most 25
// words and links to the company's own pages are published: never audio, a
// transcript or a long passage.

export type CallMetric =
  | 'capex'
  | 'revenue'
  | 'segment_revenue'
  | 'ai_revenue'
  | 'gross_margin'
  | 'backlog'
export type CallUnit = 'USD' | 'percent' | 'growth_yoy' | 'growth_qoq'
export type CallBound = 'range' | 'about' | 'at_least' | 'at_most'
export type CallSource = 'exhibit' | 'transcript' | 'remarks' | 'audio'
export type CallState = 'met' | 'above' | 'below' | 'open' | 'unscored'

export const CALL_METRIC_LABEL: Readonly<Record<CallMetric, string>> = {
  capex: 'Capex',
  revenue: 'Revenue',
  segment_revenue: 'Segment revenue',
  ai_revenue: 'AI revenue',
  gross_margin: 'Gross margin',
  backlog: 'Backlog (RPO)',
}

export const CALL_SOURCE_LABEL: Readonly<Record<CallSource, string>> = {
  exhibit: 'Filing exhibit',
  transcript: 'Company transcript',
  remarks: 'Prepared remarks',
  audio: 'Replay, transcribed',
}

export interface CallStatementSource {
  source: CallSource
  /** The document the figure was read from: an EDGAR exhibit, or the company's own file or page. */
  url: string
  /** The company's own page for the call. */
  page_url: string | null
  produced_by: string | null
  page: number | null
  /** Where in the replay the sentence starts. */
  at_ms: number | null
}

export interface CallStatement {
  id: string
  ticker: string
  company: string
  call_date: string
  /** The quarter the call reported. */
  call_period: string
  metric: CallMetric
  segment: string | null
  basis: 'gaap' | 'non_gaap' | null
  unit: CallUnit
  bound: CallBound
  period: string
  period_end: string
  low: number
  high: number
  quote: string
  speaker: string | null
  sources: CallStatementSource[]
  first_seen_at: string
  state: CallState
  /** Why a statement is unscored. */
  reason: string | null
  actual: {
    value: number
    concept: string
    form: string
    filed: string
    accession_no: string
    filing_url: string
    first_seen_at: string
  } | null
  /** (actual − midpoint) / midpoint for dollars; (actual − midpoint) / 100 for a percentage. */
  error_share: number | null
}

export interface CallCoverage {
  ticker: string
  company: string
  posts: 'transcript' | 'remarks' | 'webcast' | 'none'
  ir_url: string
  documents: { exhibit: number; transcript: number; remarks: number; audio: number }
  statements: number
  scored: number
  gap: string | null
}

export interface CallTally {
  statements: number
  scored: number
  met: number
  above: number
  below: number
  open: number
  unscored: number
  /** Median of |error_share| over the scored dollar figures, as a share. */
  median_abs_error: number | null
}

export interface CallGuidanceData {
  as_of: string | null
  computed_at: string
  rule: string
  ticker: string | null
  statements: CallStatement[]
  /** How many statements the cut left out (the default view lists the newest). */
  omitted: number
  tally: CallTally
  companies: CallCoverage[]
}
