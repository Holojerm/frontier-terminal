// The deal half of the ground-truth payload: each press headline that states
// the size of a deal between a lab and another company, against the figure
// that company filed.
//
// A headline's deal size and a filed figure are often different measures, so
// the first step is a fixed table (DEAL_MEASURES): which filed figure answers
// which kind of deal, and whether the two can be compared at all. A backlog
// balance falls as the contract is delivered, so it never scores a contract's
// headline value. A report with no comparable filed figure is `unsettled`,
// with the reason. Nothing here is fitted to the headlines.
//
// What can be compared is scored like revenue (terminal-ground-truth.ts): only
// against a figure not yet filed on the day of the report, within TOLERANCE_PCT.

import type { ExposureTicker } from '../../../companies/shared/utils/terminal-exposure'
import type {
  DealMetric,
  DealUnsettledReason,
  GroundTruthDeal,
  GroundTruthDealFiled,
  GroundTruthDealMeasure,
  GroundTruthDealTally,
} from '../../shared/utils/terminal-types/ground-truth'
import type { LabId } from '../../../core/shared/utils/terminal-types/common'

import { labName } from '#layers/core/shared/utils/lab-names'
import { FILER_NAMES, filingUrl, type StoredFact } from '../../../companies/server/exposure/series'
import { middle } from '../../../core/server/utils/terminal-median'
import { type StoredDeal } from './terminal-reported'

/** Deal reports listed. The tally counts all of them. */
export const DEAL_LIMIT = 100

const DAY_MS = 86_400_000
const dayOf = (iso: string) => iso.slice(0, 10)
const utc = (day: string) => Date.parse(`${day}T00:00:00Z`)
const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY_MS)

/** The names a headline uses for a filer we read, lower case. Anything else is a company we don't read. */
const FILER_ALIASES: Readonly<Record<string, ExposureTicker>> = {
  amazon: 'AMZN',
  'amazon.com': 'AMZN',
  aws: 'AMZN',
  'amazon web services': 'AMZN',
  microsoft: 'MSFT',
  azure: 'MSFT',
  'microsoft azure': 'MSFT',
  google: 'GOOGL',
  alphabet: 'GOOGL',
  'google cloud': 'GOOGL',
  meta: 'META',
  'meta platforms': 'META',
  oracle: 'ORCL',
  'oracle cloud': 'ORCL',
}

/** The filer a headline's counterparty is, or null. */
export function filerOf(counterparty: string | null): ExposureTicker | null {
  return counterparty ? (FILER_ALIASES[counterparty.trim().toLowerCase()] ?? null) : null
}

interface Measure {
  lab: LabId
  /** Null: the lab's own prospectus. */
  ticker: ExposureTicker | null
  metric: DealMetric
  label: string
  /** added: the amount a deal added in one quarter. total: a balance that is the whole amount. */
  compares: 'added' | 'total' | null
  why: string | null
  /** The filed facts it reads. Absent for the prospectus, whose figures arrive as `aggregates`. */
  concept?: string
  member?: string
}

const ANTHROPIC = 'amzn:AnthropicMember'
const OPENAI_AT_MSFT = 'msft:OpenAIGlobalLlcMember'

export const DEAL_MEASURES: readonly Measure[] = [
  {
    lab: 'anthropic',
    ticker: 'AMZN',
    metric: 'commitment',
    label: 'Commitment Anthropic added to Amazon’s backlog',
    compares: 'added',
    why: null,
    concept: 'amzn:RevenueRemainingPerformanceObligationAmountPeriodIncreaseDecrease',
    member: ANTHROPIC,
  },
  {
    lab: 'anthropic',
    ticker: 'AMZN',
    metric: 'financing',
    label: 'Financing Amazon makes available to Anthropic, maximum',
    compares: 'total',
    why: null,
    concept: 'us-gaap:LineOfCreditFacilityMaximumBorrowingCapacity',
    member: ANTHROPIC,
  },
  {
    lab: 'anthropic',
    ticker: 'AMZN',
    metric: 'investment',
    label: 'Anthropic shares Amazon holds, and its gains on them',
    compares: null,
    why: 'Amazon files the Anthropic shares it holds and its gains on them. It files no dollar amount invested.',
  },
  {
    lab: 'openai',
    ticker: 'AMZN',
    metric: 'commitment',
    label: 'Amazon’s backlog from OpenAI',
    compares: null,
    why: 'Amazon files the backlog left on its OpenAI contract at each quarter end. That falls as Amazon delivers, so it isn’t the contract’s headline value.',
  },
  {
    lab: 'openai',
    ticker: 'MSFT',
    metric: 'investment',
    label: 'Microsoft’s total funding commitment to OpenAI',
    compares: 'total',
    why: null,
    concept: 'msft:EquityMethodInvestmentsTotalFundingCommitments',
    member: OPENAI_AT_MSFT,
  },
  {
    lab: 'anthropic',
    ticker: null,
    metric: 'commitment_total',
    label: 'Anthropic’s aggregate obligations',
    compares: 'total',
    why: null,
  },
]

/** What a deal of each kind is called in a reason. */
const DEAL_NOUN: Readonly<Record<DealMetric, string>> = {
  commitment: 'contract',
  investment: 'investment',
  financing: 'financing',
  commitment_total: 'commitment',
}

const filerName = (m: Measure) => (m.ticker ? FILER_NAMES[m.ticker] : labName(m.lab))

export const dealMeasures = (): GroundTruthDealMeasure[] =>
  DEAL_MEASURES.map((m) => ({
    lab: m.lab,
    filer: filerName(m),
    metric: m.metric,
    label: m.label,
    compares: m.compares,
    why: m.why,
  }))

/** A lab's aggregate obligations as one filing of its prospectus states them. */
export interface FiledAggregate {
  lab: LabId
  value: number
  filed: string
  form: string
  accession_no: string
  filing_url: string
  source_url: string
  fetched_at: string
}

/** A filed figure with the period it covers: `start` is null for a balance. */
type Figure = GroundTruthDealFiled & { start: string | null; end: string }

const quarterLabel = (start: string, end: string) => {
  const month = Number(end.slice(5, 7))
  const days = daysBetween(start, end) + 1
  return days >= 80 && days <= 100 && month % 3 === 0
    ? `Q${month / 3} ${end.slice(0, 4)}`
    : `${start} to ${end}`
}

/** Each period of a measure at the filing that first printed it. */
export function measureFigures(m: Measure, facts: readonly StoredFact[]): Figure[] {
  if (!m.ticker || !m.concept || !m.member) return []
  const first = new Map<string, StoredFact>()
  for (const f of facts) {
    if (f.ticker !== m.ticker || f.concept !== m.concept || f.unit !== 'USD') continue
    if (!f.dims.split(';').some((d) => d.endsWith(`=${m.member}`))) continue
    const key = `${f.start ?? ''}|${f.end}`
    const held = first.get(key)
    if (
      !held ||
      f.filed < held.filed ||
      (f.filed === held.filed && f.accession_no < held.accession_no)
    ) {
      first.set(key, f)
    }
  }
  return [...first.values()].map((f) => ({
    filer: FILER_NAMES[m.ticker!],
    ticker: m.ticker,
    label: m.label,
    period: f.start ? quarterLabel(f.start, f.end) : `at ${f.end}`,
    value: f.value,
    first_filed: f.filed,
    form: f.form,
    accession_no: f.accession_no,
    filing_url: filingUrl(f.cik, f.accession_no),
    source_url: f.source_url,
    fetched_at: f.fetched_at,
    start: f.start,
    end: f.end,
  }))
}

function aggregateFigures(m: Measure, aggregates: readonly FiledAggregate[]): Figure[] {
  return aggregates
    .filter((a) => a.lab === m.lab)
    .map((a) => ({
      filer: filerName(m),
      ticker: null,
      label: m.label,
      period: `filed ${a.filed}`,
      value: a.value,
      first_filed: a.filed,
      form: a.form,
      accession_no: a.accession_no,
      filing_url: a.filing_url,
      source_url: a.source_url,
      fetched_at: a.fetched_at,
      // An undated aggregate speaks as of its filing.
      start: null,
      end: a.filed,
    }))
}

const errorPct = (amount: number, filed: number) => ((amount - filed) / filed) * 100

function nearest(amount: number, figures: readonly Figure[]): Figure | null {
  let best: Figure | null = null
  for (const f of figures) {
    if (!best || Math.abs(errorPct(amount, f.value)) < Math.abs(errorPct(amount, best.value))) {
      best = f
    }
  }
  return best
}

/**
 * The filed figure a report is held to, among figures not public on its day.
 * added: the quarter the report was published in, else the nearest quarter
 * that had ended and wasn't filed yet, when within tolerance. total: the
 * first balance dated on or after the report.
 */
function pending(
  compares: 'added' | 'total',
  amount: number,
  day: string,
  figures: readonly Figure[],
  tolerance: number,
): Figure | null {
  const later = figures.filter((f) => f.first_filed > day)
  if (compares === 'total') {
    return later.filter((f) => f.end >= day).sort((a, b) => a.end.localeCompare(b.end))[0] ?? null
  }
  const current = later.find((f) => f.start !== null && f.start <= day && day <= f.end)
  if (current) return current
  const ended = nearest(
    amount,
    later.filter((f) => f.end < day),
  )
  return ended && Math.abs(errorPct(amount, ended.value)) <= tolerance ? ended : null
}

export interface DealContext {
  facts: readonly StoredFact[]
  aggregates: readonly FiledAggregate[]
  tolerance_pct: number
}

function unsettledWhy(
  deal: StoredDeal,
  ticker: ExposureTicker | null,
  measure: Measure | undefined,
): { reason: DealUnsettledReason; why: string } | null {
  if (deal.currency !== 'USD') {
    return {
      reason: 'different-measure',
      why: 'The headline states euros. The filings we read state dollars.',
    }
  }
  if (deal.metric === 'commitment_total') {
    return measure
      ? null
      : {
          reason: 'not-filed',
          why: `${labName(deal.lab)} hasn’t filed its obligations with the SEC.`,
        }
  }
  if (!ticker) {
    return {
      reason: 'no-filer',
      why: `We don’t read ${deal.counterparty}’s filings. We read Microsoft, Alphabet, Amazon, Meta, and Oracle.`,
    }
  }
  if (measure) {
    return measure.compares ? null : { reason: 'different-measure', why: measure.why! }
  }
  return {
    reason: 'not-filed',
    why: `${FILER_NAMES[ticker]}’s filings state no ${DEAL_NOUN[deal.metric]} figure that names ${labName(deal.lab)}.`,
  }
}

/** One deal report against the filed figures. */
export function scoreDeal(deal: StoredDeal, ctx: DealContext): GroundTruthDeal {
  const { judged_at: _judged, basis: _basis, ...row } = deal
  const base = {
    ...row,
    reason: null,
    why: null,
    filed: null,
    error_pct: null,
    lead_days: null,
    held_before_filing: null,
  }
  const ticker = filerOf(deal.counterparty)
  const measure = DEAL_MEASURES.find(
    (m) =>
      m.lab === deal.lab &&
      m.metric === deal.metric &&
      (deal.metric === 'commitment_total' ? m.ticker === null : m.ticker === ticker),
  )
  const unsettled = unsettledWhy(deal, ticker, measure)
  if (unsettled || !measure?.compares) return { ...base, state: 'unsettled', ...unsettled }

  const figures = measure.ticker
    ? measureFigures(measure, ctx.facts)
    : aggregateFigures(measure, ctx.aggregates)
  const day = dayOf(deal.published_at)
  const strip = ({ start: _start, end: _end, ...filed }: Figure): GroundTruthDealFiled => filed

  // A figure already filed can only be repeated.
  const repeated = nearest(
    deal.amount,
    figures.filter((f) => f.first_filed <= day),
  )
  if (repeated && Math.abs(errorPct(deal.amount, repeated.value)) <= ctx.tolerance_pct) {
    return {
      ...base,
      state: 'restated',
      filed: strip(repeated),
      error_pct: errorPct(deal.amount, repeated.value),
    }
  }
  const target = pending(measure.compares, deal.amount, day, figures, ctx.tolerance_pct)
  if (!target) return { ...base, state: 'open' }
  const error_pct = errorPct(deal.amount, target.value)
  return {
    ...base,
    state: Math.abs(error_pct) <= ctx.tolerance_pct ? 'matched' : 'missed',
    filed: strip(target),
    error_pct,
    lead_days: daysBetween(day, target.first_filed),
    held_before_filing: dayOf(deal.found_at) < target.first_filed,
  }
}

export function dealTally(deals: readonly GroundTruthDeal[]): GroundTruthDealTally {
  const scored = deals.filter((d) => d.state === 'matched' || d.state === 'missed')
  const count = (state: GroundTruthDeal['state']) => deals.filter((d) => d.state === state).length
  return {
    reports: deals.length,
    scored: scored.length,
    missed: count('missed'),
    restated: count('restated'),
    open: count('open'),
    unsettled: count('unsettled'),
    held: scored.filter((d) => d.held_before_filing).length,
    median_abs_error_pct: scored.length ? middle(scored.map((d) => Math.abs(d.error_pct!))) : null,
  }
}

/** Every deal the judge labeled as fact, scored, newest first. */
export function scoreDeals(deals: readonly StoredDeal[], ctx: DealContext): GroundTruthDeal[] {
  return deals
    .filter((d) => d.basis === 'reported')
    .map((d) => scoreDeal(d, ctx))
    .sort((a, b) => b.published_at.localeCompare(a.published_at) || a.url.localeCompare(b.url))
}
