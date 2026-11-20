// The filed-fact rule: when a new 10-Q or 10-K moves a hyperscaler series,
// one alert that states the number ("Amazon marks its Anthropic stake up by
// $X", "Microsoft’s capex hits $Y"), citing one change row that carries the
// point and the one before it. No model in the loop.
//
// Only a series' newest point qualifies, only from a filing filed in the last
// FRESH_DAYS, and only once the filer has history: the first read of a filer
// is a quiet baseline, so turning the feature on does not alert on the last
// two weeks of filings. Ids hash the series, the period and the accession, so
// a re-run writes nothing twice.
//
// A point for a period an earlier filing already reported (a 10-Q repeating
// last quarter's balance, or restating it) doesn't alert, and neither does a
// balance that ends where the point before it did. The tier is `notable`,
// `critical` for a series' first point (a filer names a lab in a new line) or
// when a commitment or stake moves CRITICAL_MOVE or more.

import { compactUsd } from '../../shared/utils/terminal-format'
import type { ExposurePoint, ExposureSeries } from '../../shared/utils/terminal-exposure'
import { AlertRow, ChangeRow, contentHash, type Provider } from '../pipeline/contracts'
import { alertKind, type AlertKind } from './series'

export const FILED_FACT_RULE = 'filed-fact-floor' as const

/** How recent a filing must be for its point to alert. */
export const FRESH_DAYS = 14

/** A commitment or stake that moves this much against the point before is critical. */
export const CRITICAL_MOVE = 0.25

const PROVIDER_OF: Readonly<Record<string, Provider>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  GOOGL: 'google',
  META: 'meta',
}

/** What a backlog series is called in a headline: "backlog", "Google Cloud backlog". */
const HEADLINE_NAME: Readonly<Record<string, string>> = {
  'msft-rpo-commercial': 'commercial backlog',
  'googl-rpo-cloud': 'Google Cloud backlog',
  'googl-rpo-investee': 'backlog from Crux AI',
  'amzn-rpo-openai': 'backlog from OpenAI',
}

const MONTHS: Readonly<Record<number, string>> = { 6: 'six months', 9: 'nine months', 12: 'year' }

const signed = (n: number) => (n < 0 ? `a ${compactUsd(-n)} loss` : `a ${compactUsd(n)} gain`)

/** A figure as a headline states it: dollars, or a stake as a percent. */
const figure = (series: ExposureSeries, v: number) =>
  series.unit === 'pure' ? `${Math.round(v * 1000) / 10}%` : compactUsd(v)

interface Line {
  series: ExposureSeries
  p: ExposurePoint
  prev: ExposurePoint | null
  /** "in the quarter to 2026-09-30", "in the nine months to 2026-09-30". */
  quarter: string
  /** "at 2026-09-30". */
  at: string
  /** "hits $X in the quarter to E, up from $Y": the verb by direction, then the period. */
  move: (verbUp: string, verbDown: string, period: string) => string
}

/** Headlines for the lab series, by `<lab>|<concept>`. */
const LAB_HEADLINES: Readonly<Record<string, (l: Line) => string>> = {
  'openai|us-gaap:NonoperatingIncomeExpense': ({ series, p, quarter }) =>
    `${series.filer} books ${signed(p.value)} on OpenAI ${quarter}`,
  'openai|us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax': ({
    series,
    quarter,
    move,
  }) => `${series.filer}’s revenue from OpenAI ${move('hits', 'falls to', quarter)}`,
  'openai|us-gaap:AccountsReceivableNet': ({ series, at, move }) =>
    `${series.filer}’s receivables from OpenAI ${move('reach', 'fall to', at)}`,
  'openai|msft:EquityMethodInvestmentsTotalFundingCommitments': ({ series, at, move }) =>
    `${series.filer}’s funding commitment to OpenAI ${move('reaches', 'falls to', at)}`,
  'openai|msft:EquityMethodInvestmentsFunded': ({ series, at, move }) =>
    `${series.filer}’s funding paid in to OpenAI ${move('reaches', 'falls to', at)}`,
  'openai|us-gaap:EquityMethodInvestmentOwnershipPercentage': ({ series, p, prev, at }) =>
    prev
      ? `${series.filer}’s stake in OpenAI ${p.value >= prev.value ? 'rises' : 'falls'} to ${figure(series, p.value)} ${at}, from ${figure(series, prev.value)}`
      : `${series.filer} reports a ${figure(series, p.value)} stake in OpenAI ${at}`,
  'anthropic|us-gaap:EquitySecuritiesWithoutReadilyDeterminableFairValueUpwardPriceAdjustmentAnnualAmount':
    ({ series, p, quarter }) =>
      p.value > 0
        ? `${series.filer} marks its Anthropic stake up by ${compactUsd(p.value)} ${quarter}`
        : `${series.filer} books no upward mark on its Anthropic stake ${quarter}`,
  'anthropic|amzn:RevenueRemainingPerformanceObligationAmountPeriodIncreaseDecrease': ({
    series,
    p,
    quarter,
  }) =>
    p.value >= 0
      ? `${series.filer} adds ${compactUsd(p.value)} from Anthropic to its backlog ${quarter}`
      : `${series.filer}’s backlog from Anthropic falls by ${compactUsd(-p.value)} ${quarter}`,
  'anthropic|us-gaap:LineOfCreditFacilityMaximumBorrowingCapacity': ({ series, at, move }) =>
    `${series.filer}’s financing line to Anthropic ${move('reaches', 'falls to', at)}`,
  'anthropic|us-gaap:LineOfCreditFacilityCurrentBorrowingCapacity': ({ series, at, move }) =>
    `${series.filer}’s financing available to Anthropic ${move('reaches', 'falls to', at)}`,
}

/** The alert's one line, from the point and the one before it. */
export function headlineFor(
  series: ExposureSeries,
  p: ExposurePoint,
  prev: ExposurePoint | null,
): string {
  const move = (verbUp: string, verbDown: string, period: string) => {
    if (!prev) return `${verbUp} ${figure(series, p.value)} ${period}`
    const up = p.value >= prev.value
    return `${up ? verbUp : verbDown} ${figure(series, p.value)} ${period}, ${up ? 'up ' : ''}from ${figure(series, prev.value)}`
  }
  const quarter =
    p.months === null || p.months === 3
      ? `in the quarter to ${p.end}`
      : `in the ${MONTHS[p.months] ?? `${p.months} months`} to ${p.end}`
  const at = `at ${p.end}`
  if (series.group === 'capex') {
    return `${series.filer}’s capex ${move('hits', 'falls to', quarter)}`
  }
  if (series.group === 'rpo') {
    // A backlog falls as contracts are delivered, so a lower one "falls to", never "cut".
    const name = HEADLINE_NAME[series.id] ?? 'backlog'
    return `${series.filer}’s ${name} ${move('reaches', 'falls to', at)}`
  }
  const lab = LAB_HEADLINES[`${series.group}|${series.concept}`]
  if (lab) return lab({ series, p, prev, quarter, at, move })
  const from = prev ? `, from ${figure(series, prev.value)}` : ''
  return `${series.filer} reports ${series.label.toLowerCase()} of ${figure(series, p.value)} ${p.start ? quarter : at}${from}`
}

/** The relative move from one value to the next; Infinity from zero to anything else. */
const relativeMove = (from: number, to: number) =>
  from === 0 ? (to === 0 ? 0 : Infinity) : Math.abs(to - from) / Math.abs(from)

/** The alert's tier, and the sentence that says why when it's critical. */
export function severityFor(
  kind: AlertKind,
  series: ExposureSeries,
  p: ExposurePoint,
  prev: ExposurePoint | null,
  first: boolean,
): { severity: 'notable' | 'critical'; why: string } {
  if (first) {
    return {
      severity: 'critical',
      why: `It’s the first time ${series.filer}’s filings report this line.`,
    }
  }
  if ((kind === 'commitment' || kind === 'stake') && prev) {
    const moved = relativeMove(prev.value, p.value)
    if (moved >= CRITICAL_MOVE) {
      return {
        severity: 'critical',
        why: Number.isFinite(moved)
          ? `That’s a ${Math.round(moved * 100)}% move from the point before.`
          : 'The point before it was zero.',
      }
    }
  }
  return { severity: 'notable', why: '' }
}

export interface FiledFactAlert {
  change: ChangeRow
  alert: AlertRow
}

/** The change and alert for a series' newest point; null when it doesn't qualify. */
export function filedFactAlert(
  series: ExposureSeries,
  ctx: {
    now: Date
    firstReadAt: string
    cik: string
    /** The series' points before its newest point's filing (`earlierPoints`). */
    earlier: (series: ExposureSeries) => readonly ExposurePoint[]
  },
): FiledFactAlert | null {
  const kind = alertKind(series)
  const p = series.points.at(-1)
  if (!kind || !p) return null
  const freshFrom = new Date(ctx.now.getTime() - FRESH_DAYS * 86_400_000).toISOString().slice(0, 10)
  if (p.filed < freshFrom || p.fetched_at <= ctx.firstReadAt) return null
  const prev = series.points.at(-2) ?? null
  // A balance that ends where it was doesn't move the series.
  if (series.kind === 'balance' && prev && prev.value === p.value) return null
  const earlier = ctx.earlier(series)
  // An earlier filing already reported this period: a repeat or a restatement, not news.
  if (earlier.some((e) => e.start === p.start && e.end === p.end)) return null
  const { severity, why } = severityFor(kind, series, p, prev, earlier.length === 0)
  const headline = headlineFor(series, p, prev)
  const after = {
    series_id: series.id,
    filer: series.filer,
    ticker: series.ticker,
    cik: ctx.cik,
    label: series.label,
    concept: series.concept,
    dims: series.dims,
    kind: series.kind,
    start: p.start,
    end: p.end,
    value: p.value,
    derived: p.derived,
    less: p.less,
    accession_no: p.accession_no,
    form: p.form,
    filed: p.filed,
    filing_url: p.filing_url,
    previous: prev ? { start: prev.start, end: prev.end, value: prev.value } : null,
  }
  const after_json = JSON.stringify(after)
  // Detected by the read that stored the point's newest fact, like any change.
  const detected_at = p.fetched_at
  const change = ChangeRow.parse({
    id: contentHash({
      rule: FILED_FACT_RULE,
      series: series.id,
      end: p.end,
      accession: p.accession_no,
    }),
    entity_key: `filed_fact:${series.id}:${p.end}`,
    entity_type: 'filed_fact',
    provider: PROVIDER_OF[series.group] ?? PROVIDER_OF[series.ticker] ?? 'other',
    change_type: 'added',
    before_hash: null,
    after_hash: contentHash(after),
    before_json: null,
    after_json,
    detected_at,
    source_url: p.source_url,
    fetched_at: p.fetched_at,
  })
  const period = p.start ? `${p.start} to ${p.end}` : `at ${p.end}`
  const explanation = [
    `${series.filer} (CIK ${ctx.cik}) reported ${series.label.toLowerCase()} of ${figure(series, p.value)} ${period} in its ${p.form} filed ${p.filed}, accession ${p.accession_no}.`,
    p.derived && p.less
      ? `That quarter is the filing’s year-to-date figure less the ${compactUsd(p.less.value)} reported for ${p.less.start} to ${p.less.end} (accession ${p.less.accession_no}).`
      : '',
    prev ? `The point before it, ${prev.end}, was ${figure(series, prev.value)}.` : '',
    why,
    `Read from XBRL ${series.concept}${series.dims ? ` on ${series.dims}` : ''}.`,
    series.note ?? `It’s ${series.filer}’s number.`,
    'Rule-based: a new 10-Q or 10-K that moves a hyperscaler series alerts, no model in the loop.',
  ]
    .filter(Boolean)
    .join(' ')
  const alert = AlertRow.parse({
    id: contentHash({ rule: FILED_FACT_RULE, change_id: change.id }),
    severity,
    headline,
    explanation,
    change_ids: JSON.stringify([change.id]),
    rule: FILED_FACT_RULE,
    created_at: detected_at,
    source_url: p.source_url,
    fetched_at: p.fetched_at,
  })
  return { change, alert }
}
