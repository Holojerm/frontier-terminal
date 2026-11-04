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

import { compactUsd } from '../../shared/utils/terminal-format'
import type { ExposurePoint, ExposureSeries } from '../../shared/utils/terminal-exposure'
import { AlertRow, ChangeRow, contentHash, type Provider } from '../pipeline/contracts'

export const FILED_FACT_RULE = 'filed-fact-floor' as const

/** How recent a filing must be for its point to alert. */
export const FRESH_DAYS = 14

const PROVIDER_OF: Readonly<Record<string, Provider>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  GOOGL: 'google',
  META: 'meta',
}

/** What a series is called in a headline: "capex", "backlog", "Google Cloud backlog". */
const HEADLINE_NAME: Readonly<Record<string, string>> = {
  'msft-rpo-commercial': 'commercial backlog',
  'googl-rpo-cloud': 'Google Cloud backlog',
}

const MONTHS: Readonly<Record<number, string>> = { 6: 'six months', 9: 'nine months', 12: 'year' }

const signed = (n: number) => (n < 0 ? `a ${compactUsd(-n)} loss` : `a ${compactUsd(n)} gain`)

/** The alert's one line, from the point and the one before it. */
export function headlineFor(
  series: ExposureSeries,
  p: ExposurePoint,
  prev: ExposurePoint | null,
): string {
  const move = (verbUp: string, verbDown: string, at: string) => {
    if (!prev) return `${verbUp} ${compactUsd(p.value)} ${at}`
    const up = p.value >= prev.value
    return `${up ? verbUp : verbDown} ${compactUsd(p.value)} ${at}, ${up ? 'up ' : ''}from ${compactUsd(prev.value)}`
  }
  const quarter =
    p.months === null || p.months === 3
      ? `in the quarter to ${p.end}`
      : `in the ${MONTHS[p.months] ?? `${p.months} months`} to ${p.end}`
  if (series.group === 'capex') {
    return `${series.filer}’s capex ${move('hits', 'falls to', quarter)}`
  }
  if (series.group === 'rpo') {
    const name = HEADLINE_NAME[series.id] ?? 'backlog'
    return `${series.filer}’s ${name} ${move('reaches', 'falls to', `at ${p.end}`)}`
  }
  if (series.group === 'openai') {
    return `${series.filer} books ${signed(p.value)} on OpenAI ${quarter}`
  }
  return p.value > 0
    ? `${series.filer} marks its Anthropic stake up by ${compactUsd(p.value)} ${quarter}`
    : `${series.filer} books no upward mark on its Anthropic stake ${quarter}`
}

export interface FiledFactAlert {
  change: ChangeRow
  alert: AlertRow
}

/** The change and alert for a series' newest point; null when it doesn't qualify. */
export function filedFactAlert(
  series: ExposureSeries,
  ctx: { now: Date; firstReadAt: string; cik: string },
): FiledFactAlert | null {
  const p = series.points.at(-1)
  if (!p) return null
  const freshFrom = new Date(ctx.now.getTime() - FRESH_DAYS * 86_400_000).toISOString().slice(0, 10)
  if (p.filed < freshFrom || p.fetched_at <= ctx.firstReadAt) return null
  const prev = series.points.at(-2) ?? null
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
    `${series.filer} (CIK ${ctx.cik}) reported ${series.label.toLowerCase()} of ${compactUsd(p.value)} ${period} in its ${p.form} filed ${p.filed}, accession ${p.accession_no}.`,
    p.derived && p.less
      ? `That quarter is the filing’s year-to-date figure less the ${compactUsd(p.less.value)} reported for ${p.less.start} to ${p.less.end} (accession ${p.less.accession_no}).`
      : '',
    prev ? `The point before it, ${prev.end}, was ${compactUsd(prev.value)}.` : '',
    `Read from XBRL ${series.concept}${series.dims ? ` on ${series.dims}` : ''}.`,
    series.note ?? `It’s ${series.filer}’s number.`,
    'Rule-based: a new 10-Q or 10-K that moves a hyperscaler series always alerts, no model in the loop.',
  ]
    .filter(Boolean)
    .join(' ')
  const alert = AlertRow.parse({
    id: contentHash({ rule: FILED_FACT_RULE, change_id: change.id }),
    severity: 'notable',
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
