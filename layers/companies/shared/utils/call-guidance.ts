// What management guided on earnings calls, scored against what the company
// filed later (GET /api/call-guidance, the /ground-truth panel, the
// get_call_guidance MCP tool). Only scored figures, quotes of at most 25
// words and links to the company's own pages are published: never audio, a
// transcript or a long passage.

import type { LabId } from '../../../core/shared/types/common'
import { grouped, roundBillions } from '../../../core/shared/utils/terminal-format'

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
  /** The lab whose listed ties chose the companies (?lab=), or null. */
  lab: LabId | null
  statements: CallStatement[]
  /** How many statements the cut left out (the default view lists the newest). */
  omitted: number
  tally: CallTally
  companies: CallCoverage[]
}

// The /ground-truth panel and the tear sheet print a statement the same way.

const pct = (n: number) => `${grouped(n, Number.isInteger(n) ? 0 : 1)}%`
// Under a billion in millions: $650M, not $0.7B.
const dollars = (n: number) => (n < 1e9 ? `$${grouped(n / 1e6)}M` : roundBillions(n))

/** One figure in a statement's unit: '$650M', '$38B', '42%'. */
export const callValue = (n: number, unit: CallUnit): string =>
  unit === 'USD' ? dollars(n) : pct(n)

/** What was guided, as said: 'At least $38B', '$64B to $72B', '20% growth'. */
export function callGuided(s: Pick<CallStatement, 'bound' | 'low' | 'high' | 'unit'>): string {
  const prefix = s.bound === 'at_least' ? 'At least ' : s.bound === 'at_most' ? 'At most ' : ''
  const value =
    s.low === s.high
      ? callValue(s.low, s.unit)
      : `${callValue(s.low, s.unit)} to ${callValue(s.high, s.unit)}`
  const growth =
    s.unit === 'growth_yoy' ? ' growth' : s.unit === 'growth_qoq' ? ' sequential growth' : ''
  return `${prefix}${value}${growth}`
}

/** The measure: 'Capex', 'Segment revenue: Cloud'. */
export const callWhat = (s: Pick<CallStatement, 'metric' | 'segment'>): string =>
  s.segment ? `${CALL_METRIC_LABEL[s.metric]}: ${s.segment}` : CALL_METRIC_LABEL[s.metric]

/** How the filed figure landed: 'Met', '4% above', '1.5 pts below', 'Not filed yet'. */
export function callResult(s: Pick<CallStatement, 'state' | 'unit' | 'error_share'>): string {
  switch (s.state) {
    case 'met':
      return 'Met'
    case 'above':
    case 'below': {
      const e = s.error_share ?? 0
      const size =
        s.unit === 'USD' ? pct(Math.abs(e) * 100) : `${grouped(Math.abs(e) * 100, 1)} pts`
      return `${size} ${s.state}`
    }
    case 'open':
      return 'Not filed yet'
    default:
      return 'Not scored'
  }
}
