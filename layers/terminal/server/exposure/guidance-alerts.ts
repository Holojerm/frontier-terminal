// The capex-guidance rule (docs/alerts-expansion.md, candidate 2). Two alerts,
// no model in the loop, each citing one change row written for it:
//
//   - a revision ('guidance'): a filer's earnings release prints a capex
//     figure for a fiscal year, against the filer's previous figure for that
//     year. A raised, cut, narrowed or widened range is critical; the same
//     range restated is info; the first figure for a year is notable.
//   - a check ('guidance_check'): a 10-Q or 10-K files the year-to-date capex
//     of a year that has guidance, measured as GUIDANCE_MEASURES defines it.
//     A 10-Q says what the rest of the year has to be to stay inside the
//     range: notable when the pace so far lands the year outside it, info when
//     inside. A 10-K's verdict (met, above or below) is notable. A filer we
//     can't score (Amazon, Microsoft) gets the revision alert only.
//
// The guidance sentence is the release's own. Before a stored figure alerts,
// the Worker reads the exhibit back from R2 and must find the sentence in it
// verbatim, then re-read the figure from the sentence (the filing-review.ts
// pattern). A row that fails is silence and an ops event, never a repair.
//
// The baseline is filed-fact-floor's: only a release or filing filed in the
// last FRESH_DAYS, and only one first read after the filer's first read, so
// turning this on does not alert on old guidance. Ids hash the filer, the
// year and the accessions, so a re-run writes nothing twice.

import { inArray } from 'drizzle-orm'

import { compactUsd } from '../../shared/utils/terminal-format'
import type { ExposureTicker } from '../../shared/utils/terminal-exposure'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import {
  AlertRow,
  ChangeRow,
  contentHash,
  type Provider,
} from '#layers/core/server/pipeline/contracts'
import type { RawReader } from '../pipeline/judge/class-map'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import {
  GUIDANCE_MEASURES,
  TOLERANCE_PCT,
  fiscalYear,
  scoreGuidance,
  type StoredGuidance,
} from '../utils/terminal-ground-truth-guidance'
import { FRESH_DAYS } from './alerts'
import { guidanceIn, releaseBlocks } from './guidance'
import { FILER_NAMES, filingUrl, type StoredFact } from './series'

export const GUIDANCE_RULE = 'guidance-floor' as const

const PROVIDER_OF: Readonly<Partial<Record<ExposureTicker, Provider>>> = {
  GOOGL: 'google',
  META: 'meta',
}

export interface GuidanceAlert {
  change: ChangeRow
  alert: AlertRow
}

interface Baseline {
  now: Date
  /** The filer's first read of this kind: what was stored by it is the baseline. */
  firstReadAt: string
}

const freshFrom = (now: Date) =>
  new Date(now.getTime() - FRESH_DAYS * 86_400_000).toISOString().slice(0, 10)

const isFresh = (filed: string, fetched_at: string, b: Baseline) =>
  filed >= freshFrom(b.now) && fetched_at > b.firstReadAt

/** "$135B–$145B", or "$220B" for a single figure. */
export const rangeText = (low: number, high: number) =>
  low === high ? compactUsd(low) : `${compactUsd(low)}–${compactUsd(high)}`

/** "2026" for a calendar year, "fiscal 2026" for Oracle's year to May. */
const yearName = (ticker: ExposureTicker, year: number) =>
  fiscalYear(ticker, year).end.endsWith('-12-31') ? String(year) : `fiscal ${year}`

const filerOf = (g: StoredGuidance) => FILER_NAMES[g.ticker as ExposureTicker] ?? g.ticker

// ---- the verbatim gate -----------------------------------------------------

/**
 * Why a stored figure doesn't hold against the exhibit it was read from, or
 * null when it does: the sentence is in the release's text verbatim, and the
 * figure read again from the sentence is the stored one.
 */
export function unverified(g: StoredGuidance, html: string): string | null {
  if (!releaseBlocks(html).some((block) => block.includes(g.sentence))) {
    return 'sentence-not-in-exhibit'
  }
  const again = guidanceIn(g.sentence)
  if (
    !again ||
    again.fiscal_year !== g.fiscal_year ||
    again.low !== g.low ||
    again.high !== g.high
  ) {
    return 'figure-not-in-sentence'
  }
  return null
}

// ---- revisions -------------------------------------------------------------

export type Revision = 'first' | 'raised' | 'cut' | 'narrowed' | 'widened' | 'restated'

/** How a figure moved against the filer's previous one for the same year. */
export function revisionOf(
  g: Pick<StoredGuidance, 'low' | 'high'>,
  prev: Pick<StoredGuidance, 'low' | 'high'> | null,
): Revision {
  if (!prev) return 'first'
  const low = Math.sign(g.low - prev.low)
  const high = Math.sign(g.high - prev.high)
  if (low === 0 && high === 0) return 'restated'
  if (low >= 0 && high >= 0) return 'raised'
  if (low <= 0 && high <= 0) return 'cut'
  return low > 0 ? 'narrowed' : 'widened'
}

const REVISION_SEVERITY: Readonly<Record<Revision, AlertRow['severity']>> = {
  first: 'notable',
  restated: 'info',
  raised: 'critical',
  cut: 'critical',
  narrowed: 'critical',
  widened: 'critical',
}

/** The filer's figure for the same year just before `g`: by filing date, then accession. */
export function previousGuidance(
  g: StoredGuidance,
  rows: readonly StoredGuidance[],
): StoredGuidance | null {
  const before = rows.filter(
    (r) =>
      r.ticker === g.ticker &&
      r.fiscal_year === g.fiscal_year &&
      r.accession_no !== g.accession_no &&
      (r.filed < g.filed || (r.filed === g.filed && r.accession_no < g.accession_no)),
  )
  return (
    before
      .sort(
        (a, b) => a.filed.localeCompare(b.filed) || a.accession_no.localeCompare(b.accession_no),
      )
      .at(-1) ?? null
  )
}

export function revisionHeadline(g: StoredGuidance, prev: StoredGuidance | null): string {
  const filer = filerOf(g)
  const year = yearName(g.ticker as ExposureTicker, g.fiscal_year)
  const now = rangeText(g.low, g.high)
  const revision = revisionOf(g, prev)
  if (revision === 'first' || !prev) return `${filer} guides ${year} capex to ${now}`
  if (revision === 'restated') return `${filer} restates its ${year} capex guidance of ${now}`
  // When one end of a range moves, say which: Meta calls a raised floor
  // "narrowed", and the headline must not contradict the sentence it quotes.
  const end =
    g.low === prev.low
      ? 'the top of '
      : g.high === prev.high && g.low !== g.high
        ? 'the low end of '
        : ''
  const verb = {
    raised: end ? `raises ${end}` : 'raises ',
    cut: end ? `lowers ${end}` : 'cuts ',
    narrowed: 'narrows ',
    widened: 'widens ',
  }[revision]
  return `${filer} ${verb}its ${year} capex guidance to ${now}, from ${rangeText(prev.low, prev.high)}`
}

/** The change and alert for one stored figure; null when it is baseline or old. */
export function revisionAlert(
  g: StoredGuidance,
  prev: StoredGuidance | null,
  baseline: Baseline,
): GuidanceAlert | null {
  if (!isFresh(g.filed, g.fetched_at, baseline)) return null
  const ticker = g.ticker as ExposureTicker
  const revision = revisionOf(g, prev)
  const summary = (r: StoredGuidance) => ({
    ticker: r.ticker,
    filer: filerOf(r),
    cik: r.cik,
    fiscal_year: r.fiscal_year,
    low: r.low,
    high: r.high,
    sentence: r.sentence,
    accession_no: r.accession_no,
    filed: r.filed,
    filing_url: filingUrl(r.cik, r.accession_no),
    source_url: r.source_url,
  })
  const after = { ...summary(g), revision, form: '8-K' }
  const before = prev ? summary(prev) : null
  const change = ChangeRow.parse({
    id: contentHash({
      rule: GUIDANCE_RULE,
      ticker,
      fiscal_year: g.fiscal_year,
      accession: g.accession_no,
    }),
    entity_key: `guidance:${ticker}:${g.fiscal_year}`,
    entity_type: 'guidance',
    provider: PROVIDER_OF[ticker] ?? 'other',
    change_type: before ? 'modified' : 'added',
    before_hash: before ? contentHash(before) : null,
    after_hash: contentHash(after),
    before_json: before ? JSON.stringify(before) : null,
    after_json: JSON.stringify(after),
    // Detected by the read that stored the figure, like any change.
    detected_at: g.fetched_at,
    source_url: g.source_url,
    fetched_at: g.fetched_at,
  })
  const filer = filerOf(g)
  const year = yearName(ticker, g.fiscal_year)
  const explanation = [
    `${filer}’s earnings release (exhibit 99.1 of its 8-K filed ${g.filed}, accession ${g.accession_no}) says: “${g.sentence}”`,
    prev
      ? `Its previous release with a ${year} figure, filed ${prev.filed} (accession ${prev.accession_no}), said ${rangeText(prev.low, prev.high)}: “${prev.sentence}”`
      : `It is the first ${year} capex figure we have read from ${filer}.`,
    'The sentence was found verbatim in the stored release and the figure read again from it.',
    `It’s ${filer}’s own definition of capital expenditures.`,
    'Rule-based: a capex figure in a hyperscaler’s earnings release always alerts, critical when the range moves, no model in the loop.',
  ].join(' ')
  const alert = AlertRow.parse({
    id: contentHash({ rule: GUIDANCE_RULE, change_id: change.id }),
    severity: REVISION_SEVERITY[revision],
    headline: revisionHeadline(g, prev),
    explanation,
    change_ids: JSON.stringify([change.id]),
    rule: GUIDANCE_RULE,
    created_at: g.fetched_at,
    source_url: g.source_url,
    fetched_at: g.fetched_at,
  })
  return { change, alert }
}

// ---- checks against a 10-Q or 10-K -----------------------------------------

/** One filing's year-to-date capex for a fiscal year, as GUIDANCE_MEASURES adds it up. */
export interface FiledYearToDate {
  ticker: ExposureTicker
  cik: string
  fiscal_year: number
  start: string
  end: string
  months: number
  value: number
  parts: { label: string; concept: string; value: number }[]
  form: string
  filed: string
  accession_no: string
  source_url: string
  fetched_at: string
}

const monthsBetween = (start: string, end: string) => {
  const [sy, sm] = start.split('-').map(Number) as [number, number]
  const [ey, em] = end.split('-').map(Number) as [number, number]
  return (ey - sy) * 12 + (em - sm) + 1
}

/**
 * Each 10-Q and 10-K's year-to-date capex for its fiscal year: every line the
 * filer's guided figure covers, from that filing, for the fiscal year's start
 * to the filing's latest period end. A filer we can't score yields none.
 */
export function filedYearToDate(
  ticker: ExposureTicker,
  facts: readonly StoredFact[],
): FiledYearToDate[] {
  const parts = GUIDANCE_MEASURES[ticker].parts
  if (!parts) return []
  const line = (f: StoredFact, concept: string) =>
    f.ticker === ticker &&
    f.concept === concept &&
    f.dims === '' &&
    f.unit === 'USD' &&
    f.start !== null
  const byFiling = new Map<string, StoredFact[]>()
  for (const f of facts) {
    if (!/^10-[QK]/.test(f.form) || !parts.some((p) => line(f, p.concept))) continue
    byFiling.set(f.accession_no, [...(byFiling.get(f.accession_no) ?? []), f])
  }
  const out: FiledYearToDate[] = []
  for (const [accession_no, rows] of byFiling) {
    const end = rows.map((f) => f.end).reduce((a, b) => (b > a ? b : a))
    const year = Number(end.slice(0, 4))
    const fy = [year, year + 1]
      .map((y) => ({ y, ...fiscalYear(ticker, y) }))
      .find((f) => f.start <= end && end <= f.end)
    if (!fy) continue
    const found = parts.map((p) =>
      rows.find((f) => line(f, p.concept) && f.start === fy.start && f.end === end),
    )
    if (found.some((f) => !f)) continue
    const lines = found as StoredFact[]
    const months = monthsBetween(fy.start, end)
    if (![3, 6, 9, 12].includes(months)) continue
    const newest = lines.reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))
    out.push({
      ticker,
      cik: lines[0]!.cik,
      fiscal_year: fy.y,
      start: fy.start,
      end,
      months,
      value: lines.reduce((sum, f) => sum + f.value, 0),
      parts: parts.map((p, i) => ({ label: p.label, concept: p.concept, value: lines[i]!.value })),
      form: lines[0]!.form,
      filed: lines[0]!.filed,
      accession_no,
      source_url: newest.source_url,
      fetched_at: newest.fetched_at,
    })
  }
  return out.sort(
    (a, b) => a.filed.localeCompare(b.filed) || a.accession_no.localeCompare(b.accession_no),
  )
}

/**
 * The newest figure for the filing's year that was public when it was filed.
 * A 10-Q takes a release of the same day (results are often released and filed
 * together); a 10-K, like the ground-truth score, only one filed before it.
 */
export function guidanceFor(
  ytd: FiledYearToDate,
  rows: readonly StoredGuidance[],
): StoredGuidance | null {
  const annual = ytd.months === 12
  return (
    rows
      .filter(
        (g) =>
          g.ticker === ytd.ticker &&
          g.fiscal_year === ytd.fiscal_year &&
          (annual ? g.filed < ytd.filed : g.filed <= ytd.filed),
      )
      .sort(
        (a, b) => a.filed.localeCompare(b.filed) || a.accession_no.localeCompare(b.accession_no),
      )
      .at(-1) ?? null
  )
}

export type CheckVerdict = 'inside' | 'below' | 'above' | 'met'

/** Within the range, or within TOLERANCE_PCT of a single figure, as the ground-truth score reads it. */
const within = (value: number, low: number, high: number) =>
  low === high
    ? Math.abs((value - low) / low) * 100 <= TOLERANCE_PCT
    : low <= value && value <= high

/**
 * The 10-Q's verdict: the year at the pace of the months filed so far, against
 * the range. Inside it, the implied rest of the year sits inside what the range
 * needs; outside, it doesn't. A 10-K's is the year itself, met or not.
 */
export function checkVerdict(
  ytd: Pick<FiledYearToDate, 'value' | 'months'>,
  g: Pick<StoredGuidance, 'low' | 'high'>,
) {
  const pace = (ytd.value / ytd.months) * 12
  const value = ytd.months === 12 ? ytd.value : pace
  const verdict: CheckVerdict = within(value, g.low, g.high)
    ? ytd.months === 12
      ? 'met'
      : 'inside'
    : value > g.high
      ? 'above'
      : 'below'
  return {
    verdict,
    pace,
    rest: { low: Math.max(0, g.low - ytd.value), high: Math.max(0, g.high - ytd.value) },
  }
}

export function checkHeadline(ytd: FiledYearToDate, g: StoredGuidance): string {
  const filer = FILER_NAMES[ytd.ticker]
  const year = yearName(ytd.ticker, ytd.fiscal_year)
  const range = `its ${rangeText(g.low, g.high)} guidance`
  const { verdict, rest } = checkVerdict(ytd, g)
  if (ytd.months === 12) {
    const lands = {
      met: 'lands inside',
      above: 'comes in above',
      below: 'comes in below',
      inside: '',
    }[verdict]
    return `${filer}’s ${year} capex of ${compactUsd(ytd.value)} ${lands} ${range}`
  }
  if (ytd.value > g.high) {
    return `${filer}’s capex of ${compactUsd(ytd.value)} through ${ytd.end} already passes ${range} for ${year}`
  }
  const lead = {
    inside: `${filer}’s capex is on pace for ${range} for ${year}`,
    below: `${filer}’s capex runs below ${range} for ${year}`,
    above: `${filer}’s capex runs above ${range} for ${year}`,
    met: '',
  }[verdict]
  return `${lead}: ${compactUsd(ytd.value)} through ${ytd.end} leaves ${rangeText(rest.low, rest.high)} for the rest of the year`
}

/** The change and alert for one filing's year to date; null when it is baseline or old. */
export function checkAlert(
  ytd: FiledYearToDate,
  g: StoredGuidance,
  facts: readonly StoredFact[],
  baseline: Baseline,
): GuidanceAlert | null {
  if (!isFresh(ytd.filed, ytd.fetched_at, baseline)) return null
  const annual = ytd.months === 12
  // A 10-K is scored as the ground-truth page scores it, and only by the
  // filing that first printed the whole year.
  const score = annual ? scoreGuidance(g, facts, TOLERANCE_PCT) : null
  if (score && score.actual?.accession_no !== ytd.accession_no) return null
  const { verdict, pace, rest } = checkVerdict(ytd, g)
  const filer = FILER_NAMES[ytd.ticker]
  const year = yearName(ytd.ticker, ytd.fiscal_year)
  const after = {
    ticker: ytd.ticker,
    filer,
    cik: ytd.cik,
    fiscal_year: ytd.fiscal_year,
    start: ytd.start,
    end: ytd.end,
    months: ytd.months,
    value: ytd.value,
    parts: ytd.parts,
    form: ytd.form,
    filed: ytd.filed,
    accession_no: ytd.accession_no,
    filing_url: filingUrl(ytd.cik, ytd.accession_no),
    verdict,
    pace: annual ? null : pace,
    rest: annual ? null : rest,
    error_pct: score?.error_pct ?? null,
    guidance: {
      low: g.low,
      high: g.high,
      sentence: g.sentence,
      accession_no: g.accession_no,
      filed: g.filed,
      source_url: g.source_url,
    },
  }
  const change = ChangeRow.parse({
    id: contentHash({
      rule: GUIDANCE_RULE,
      ticker: ytd.ticker,
      fiscal_year: ytd.fiscal_year,
      end: ytd.end,
      accession: ytd.accession_no,
      guidance: g.accession_no,
    }),
    entity_key: `guidance_check:${ytd.ticker}:${ytd.fiscal_year}:${ytd.end}`,
    entity_type: 'guidance_check',
    provider: PROVIDER_OF[ytd.ticker] ?? 'other',
    change_type: 'added',
    before_hash: null,
    after_hash: contentHash(after),
    before_json: null,
    after_json: JSON.stringify(after),
    detected_at: ytd.fetched_at,
    source_url: ytd.source_url,
    fetched_at: ytd.fetched_at,
  })
  const lines =
    ytd.parts.length > 1
      ? ` (${ytd.parts.map((p) => `${p.label.toLowerCase()} ${compactUsd(p.value)}`).join(' plus ')})`
      : ''
  const months = annual ? 'the year' : `the ${ytd.months} months`
  const filedLine = `${filer}’s ${ytd.form} filed ${ytd.filed} (accession ${ytd.accession_no}) reports capex of ${compactUsd(ytd.value)} for ${months} from ${ytd.start} to ${ytd.end}${lines}.`
  const guidanceLine = `Its guidance for ${year}, from the release filed ${g.filed} (accession ${g.accession_no}), is ${rangeText(g.low, g.high)}: “${g.sentence}”`
  const verdictLine = annual
    ? verdict === 'met'
      ? 'The year lands inside it.'
      : `The year comes in ${verdict} it by ${Math.abs(score!.error_pct!).toFixed(1)}%.`
    : `Staying inside it needs ${rangeText(rest.low, rest.high)} in the rest of the year. At the pace so far the year comes to ${compactUsd(pace)}, ${verdict === 'inside' ? 'inside' : verdict} the range.`
  const explanation = [
    filedLine,
    guidanceLine,
    verdictLine,
    'Rule-based: each 10-Q and 10-K of a year with guidance is checked against the newest figure, no model in the loop.',
  ].join(' ')
  const alert = AlertRow.parse({
    id: contentHash({ rule: GUIDANCE_RULE, change_id: change.id }),
    severity: annual || verdict !== 'inside' ? 'notable' : 'info',
    headline: checkHeadline(ytd, g),
    explanation,
    change_ids: JSON.stringify([change.id]),
    rule: GUIDANCE_RULE,
    created_at: ytd.fetched_at,
    source_url: ytd.source_url,
    fetched_at: ytd.fetched_at,
  })
  return { change, alert }
}

// ---- the run ---------------------------------------------------------------

export interface GuidanceBaselines {
  now: Date
  /** The filer's first release read: guidance it stored is the baseline. */
  firstReleaseReadAt: string | null
  /** The filer's first read of any kind, as filed-fact-floor keys on. */
  firstReadAt: string | null
}

/**
 * Every revision and check alert one filer's stored guidance and facts call
 * for, each figure first held to its stored exhibit. Pure but for the reads
 * of R2; the caller writes what is new.
 */
export async function guidanceAlerts(
  filer: { ticker: string },
  guidance: readonly StoredGuidance[],
  facts: readonly StoredFact[],
  readRaw: RawReader,
  b: GuidanceBaselines,
): Promise<{
  out: GuidanceAlert[]
  rejected: { accession_no: string; fiscal_year: number; reason: string }[]
}> {
  const ticker = filer.ticker as ExposureTicker
  const rows = guidance.filter((g) => g.ticker === ticker)
  const rejected: { accession_no: string; fiscal_year: number; reason: string }[] = []
  const checked = new Map<string, boolean>()
  const holds = async (g: StoredGuidance) => {
    const known = checked.get(g.id)
    if (known !== undefined) return known
    const html = await readRaw(g.raw_key)
    const reason = html === null ? 'exhibit-not-stored' : unverified(g, html)
    if (reason) rejected.push({ accession_no: g.accession_no, fiscal_year: g.fiscal_year, reason })
    checked.set(g.id, reason === null)
    return reason === null
  }

  const out: GuidanceAlert[] = []
  if (b.firstReleaseReadAt) {
    const baseline = { now: b.now, firstReadAt: b.firstReleaseReadAt }
    for (const g of rows) {
      if (!isFresh(g.filed, g.fetched_at, baseline)) continue
      const prev = previousGuidance(g, rows)
      const a = revisionAlert(g, prev, baseline)
      if (a && (await holds(g))) out.push(a)
    }
  }
  if (b.firstReadAt) {
    const baseline = { now: b.now, firstReadAt: b.firstReadAt }
    for (const ytd of filedYearToDate(ticker, facts)) {
      if (!isFresh(ytd.filed, ytd.fetched_at, baseline)) continue
      const g = guidanceFor(ytd, rows)
      if (!g) continue
      const a = checkAlert(ytd, g, facts, baseline)
      if (a && (await holds(g))) out.push(a)
    }
  }
  return { out, rejected }
}

/** Write the new alerts for one filer; returns how many were new. */
export async function writeGuidanceAlerts(
  db: PipelineDb,
  filer: { ticker: string },
  guidance: readonly StoredGuidance[],
  facts: readonly StoredFact[],
  readRaw: RawReader,
  b: GuidanceBaselines,
): Promise<number> {
  const { out, rejected } = await guidanceAlerts(filer, guidance, facts, readRaw, b)
  for (const r of rejected) {
    await recordOpsEvent(db, {
      kind: 'guidance_unverified',
      detail: `${filer.ticker} ${r.accession_no} ${r.fiscal_year}: ${r.reason}`,
    })
  }
  if (out.length === 0) return 0
  const known = new Set(
    (
      await db
        .select({ id: tables.alerts.id })
        .from(tables.alerts)
        .where(
          inArray(
            tables.alerts.id,
            out.map((a) => a.alert.id),
          ),
        )
    ).map((r) => r.id),
  )
  const fresh = out.filter((a) => !known.has(a.alert.id))
  for (const { change, alert } of fresh) {
    await db.insert(tables.changes).values(change).onConflictDoNothing()
    await db.insert(tables.alerts).values(alert).onConflictDoNothing()
  }
  return fresh.length
}
