// What a lab's own registration filings print beyond revenue — the payload of
// GET /api/prospectus and the MCP tool get_prospectus — and the formatting the
// panel and the filing page share. Every figure is the filing's own, with the
// filing it came from and the URL and fetch time of the document it was read off.

import type { LabId, Prov, SourceRef } from './terminal-types'

/** The filing a figure was printed in, and the document it was read from. */
export interface ProspectusFilingRef extends Prov {
  accession_no: string
  form: string
  filed: string
  /** EDGAR's filing index for the accession. */
  filing_url: string
}

export type StatementUnit = 'USD' | 'USD/share' | 'shares'

export interface StatementPeriodView extends ProspectusFilingRef {
  start: string
  end: string
  /** Calendar days: ~182 a half, ~273 nine months, ~365 a year. */
  days: number
  /** An interim period: registration statements print them unaudited. */
  unaudited: boolean
  /** The statement's units line, verbatim. */
  units: string
}

export interface StatementLineView {
  /** Canonical where the parser knows the line (revenue, operating_income, …), else the label slugged. */
  key: string
  /** The statement's own words, from the newest filing that prints the line. */
  label: string
  unit: StatementUnit
  /** One per period, in `periods` order: dollars, shares or dollars per share as printed; null for a dash or a line that period's filing does not print. */
  values: (number | null)[]
}

export interface StatementView {
  /** Each period once, from the newest filing that reports it; newest end first, longest span first. */
  periods: StatementPeriodView[]
  lines: StatementLineView[]
  /** Gross profit over revenue per period, only where the statement prints gross profit. */
  gross_margin: (number | null)[] | null
  /** Lines an analyst may look for that this statement does not print, by label. */
  not_printed: string[]
  /** Periods a later filing reported again, as the earlier filing printed them. */
  superseded: (StatementPeriodView & {
    lines: { key: string; label: string; unit: StatementUnit; val: number | null }[]
  })[]
}

export interface CommitmentView extends ProspectusFilingRef {
  schedule:
    | 'contractual_obligations'
    | 'purchase_commitments'
    | 'purchase_commitments_interim'
    | 'obligations_aggregate'
  as_of: string | null
  audited: boolean
  /** The filing itself calls the figure approximate. */
  approximate: boolean
  /** The sentence a one-figure schedule was read from, verbatim. */
  statement: string | null
  lines: { label: string; total: number; buckets: { label: string; val: number }[] }[]
}

export interface ConcentrationView extends ProspectusFilingRef {
  basis: 'revenue' | 'accounts_receivable'
  /** Revenue columns are periods; receivables columns are balance-sheet dates (start null). */
  columns: { start: string | null; end: string; unaudited: boolean }[]
  /** Percent of the total; null is the filing's "*": under 10%, not zero. */
  customers: { label: string; pct: (number | null)[] }[]
}

export interface SharesView extends ProspectusFilingRef {
  lines: { label: string; shares: number | null; with_option: number | null }[]
  before_as_of: string | null
  before: { label: string; shares: number | null }[]
}

export interface RiskFactorFilingView extends ProspectusFilingRef {
  count: number
  sections: { title: string; headings: string[] }[]
}

export interface RiskFactorChangeView {
  kind: 'added' | 'removed' | 'reworded'
  section: string
  heading: string
  /** For a rewording, the earlier filing's words. */
  previous: string | null
}

/** One amendment against the filing before it. */
export interface RiskFactorDiffView {
  from: ProspectusFilingRef
  to: ProspectusFilingRef
  changes: RiskFactorChangeView[]
}

export interface ProspectusIssuerView {
  provider: LabId
  display: string
  cik: string
  entity_name: string
  /** Every registration filing read, newest first. */
  filings: ProspectusFilingRef[]
  statement: StatementView
  /** Per schedule and as-of date, from the newest filing that states it; newest first. */
  commitments: CommitmentView[]
  /** Each basis from the newest filing that prints it. */
  concentration: ConcentrationView[]
  /** From the newest filing; null when none prints "The Offering". */
  shares: SharesView | null
  /** The newest filing's headings, and each amendment against the filing before it, newest first. */
  risk_factors: { latest: RiskFactorFilingView; diffs: RiskFactorDiffView[] }
  sources: SourceRef[]
}

export interface ProspectusData {
  as_of: string | null
  computed_at: string
  /** Labs whose own registration filings have been read; empty until one files. */
  issuers: ProspectusIssuerView[]
  rule: string
}

/** '33,242' / '−1,260' — a dollar figure in millions as a statement prints it, sign visible. */
export function millions(n: number): string {
  const m = Math.round(n / 1e5) / 10
  const text = Math.abs(m).toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(m) ? 0 : 1,
    maximumFractionDigits: 1,
  })
  return n < 0 ? `−${text}` : text
}

/** A statement value in its own unit: $ millions, thousands of shares, or $ per share. */
export function statementValue(val: number | null, unit: StatementUnit): string {
  if (val === null) return '—'
  if (unit === 'USD/share') return `${val < 0 ? '−' : ''}${Math.abs(val).toFixed(2)}`
  if (unit === 'shares') {
    const k = Math.round(val / 1e3).toLocaleString('en-US')
    return val < 0 ? `−${k}` : k
  }
  return millions(val)
}

/** '$895.4B' style for a commitment total, exact to the filing's printed precision. */
export function billions(n: number): string {
  const b = n / 1e9
  return `$${b >= 100 ? b.toLocaleString('en-US', { maximumFractionDigits: 1 }) : b.toFixed(1)}B`
}
