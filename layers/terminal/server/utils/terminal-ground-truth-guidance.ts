// The guidance half of the ground-truth payload: each capex figure an
// earnings release printed for a fiscal year (exposure/guidance.ts), against
// the capex the filer's 10-K later filed for that year.
//
// What a filer means by capital expenditures is its own definition, so each
// filer has one entry in GUIDANCE_MEASURES: the filed lines its figure covers,
// or the reason we can't score it. Meta's figure includes principal payments
// on finance leases, so its year is the sum of the two lines it files. Amazon
// guides a net figure we hold only the gross line for, so it is listed and
// not scored. Microsoft's release prints none.
//
// A range is met when the filed figure is inside it. A single figure is met
// within TOLERANCE_PCT. Anything else is above or below, by the distance from
// the nearer end.

import { and, eq, lt, lte } from 'drizzle-orm'

import type { ExposureTicker } from '../../shared/utils/terminal-exposure'
import type {
  GroundTruthActual,
  GroundTruthGuidance,
  GroundTruthGuidanceData,
  GroundTruthGuidanceFiler,
  GroundTruthGuidanceTally,
} from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import { GUIDANCE_SINCE } from '../exposure/guidance'
import { FILER_NAMES, filingUrl, type StoredFact } from '../exposure/series'
import type { PipelineDb } from '../pipeline/store'
import { filedBefore } from './terminal-exposure'
import { middle } from './terminal-reported'

const PPE = 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment'

/** A report matches the nearest filed figure within this many percent; a single guided figure is met within it too. */
export const TOLERANCE_PCT = 5

interface GuidanceMeasure {
  /** The filed lines the guided figure is the sum of. Null when we don't hold them all. */
  parts: { concept: string; label: string }[] | null
  compared_with: string | null
  gap: string | null
}

export const GUIDANCE_MEASURES: Readonly<Record<ExposureTicker, GuidanceMeasure>> = {
  META: {
    parts: [
      { concept: PPE, label: 'Purchases of property and equipment' },
      {
        concept: 'us-gaap:FinanceLeasePrincipalPayments',
        label: 'Principal payments on finance leases',
      },
    ],
    compared_with:
      'Meta’s figure includes principal payments on finance leases, so we add the two lines it files.',
    gap: null,
  },
  GOOGL: {
    parts: [{ concept: PPE, label: 'Purchases of property and equipment' }],
    compared_with: 'Purchases of property and equipment for the calendar year.',
    gap: null,
  },
  ORCL: {
    parts: [{ concept: PPE, label: 'Capital expenditures' }],
    compared_with: 'Capital expenditures for the fiscal year, which ends May 31.',
    gap: null,
  },
  AMZN: {
    parts: null,
    compared_with: null,
    gap: 'Amazon guides cash capital expenditures, which is purchases of property and equipment less proceeds from sales and incentives. We read the purchases line only, so we list its figures and don’t score them.',
  },
  MSFT: {
    parts: null,
    compared_with: null,
    gap: 'Microsoft’s release prints no capex figure. It gives guidance on the earnings call, which the earnings-call panel reads.',
  },
}

/** The month a filer's fiscal year ends in. */
const FISCAL_END_MONTH: Readonly<Record<ExposureTicker, number>> = {
  MSFT: 6,
  GOOGL: 12,
  AMZN: 12,
  META: 12,
  ORCL: 5,
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const pad = (n: number) => String(n).padStart(2, '0')
const DAY_MS = 86_400_000
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)

/** The dates of the fiscal year that ends in `year`, and how the page names it. */
export function fiscalYear(
  ticker: ExposureTicker,
  year: number,
): { start: string; end: string; period: string } {
  const month = FISCAL_END_MONTH[ticker]
  if (month === 12) {
    return { start: `${year}-01-01`, end: `${year}-12-31`, period: String(year) }
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    start: `${year - 1}-${pad(month + 1)}-01`,
    end: `${year}-${pad(month)}-${pad(last)}`,
    period: `Fiscal ${year} (${MONTHS[month]} ${year - 1} to ${MONTHS[month - 1]} ${year})`,
  }
}

/** The filed capex for one fiscal year, at the first filing that printed every line of it. Null until then. */
export function filedActual(
  ticker: ExposureTicker,
  year: number,
  facts: readonly StoredFact[],
): GroundTruthActual | null {
  const measure = GUIDANCE_MEASURES[ticker]
  if (!measure.parts) return null
  const { start, end } = fiscalYear(ticker, year)
  const firsts: StoredFact[] = []
  for (const part of measure.parts) {
    const first = facts
      .filter(
        (f) =>
          f.ticker === ticker &&
          f.concept === part.concept &&
          f.dims === '' &&
          f.unit === 'USD' &&
          f.start === start &&
          f.end === end,
      )
      .sort(
        (a, b) => a.filed.localeCompare(b.filed) || a.accession_no.localeCompare(b.accession_no),
      )[0]
    if (!first) return null
    firsts.push(first)
  }
  // Public once every line is: the latest of their first filings.
  const filing = firsts.reduce((a, b) => (b.filed > a.filed ? b : a))
  return {
    value: firsts.reduce((sum, f) => sum + f.value, 0),
    parts: measure.parts.map((p, i) => ({ label: p.label, value: firsts[i]!.value })),
    first_filed: filing.filed,
    form: filing.form,
    accession_no: filing.accession_no,
    filing_url: filingUrl(filing.cik, filing.accession_no),
    source_url: filing.source_url,
    fetched_at: filing.fetched_at,
  }
}

/** A stored filed_guidance row. */
export type StoredGuidance = typeof tables.filedGuidance.$inferSelect

/** One guidance figure against the filed year. */
export function scoreGuidance(
  g: StoredGuidance,
  facts: readonly StoredFact[],
  tolerance_pct: number,
): GroundTruthGuidance {
  const ticker = g.ticker as ExposureTicker
  const base = {
    ticker,
    filer: FILER_NAMES[ticker],
    fiscal_year: g.fiscal_year,
    ...fiscalYear(ticker, g.fiscal_year),
    low: g.low,
    high: g.high,
    sentence: g.sentence,
    filed: g.filed,
    accession_no: g.accession_no,
    filing_url: filingUrl(g.cik, g.accession_no),
    source_url: g.source_url,
    fetched_at: g.fetched_at,
  }
  const blank = { actual: null, error_pct: null, lead_days: null }
  if (!GUIDANCE_MEASURES[ticker].parts) return { ...base, state: 'unsettled', ...blank }
  const actual = filedActual(ticker, g.fiscal_year, facts)
  // A release filed with or after the year's own filing isn't a forecast of it.
  if (!actual || actual.first_filed <= g.filed) return { ...base, state: 'open', ...blank }

  const single = g.low === g.high
  const nearer = actual.value > g.high ? g.high : actual.value < g.low ? g.low : null
  const error_pct = nearer === null ? 0 : ((actual.value - nearer) / nearer) * 100
  const met = single ? Math.abs(error_pct) <= tolerance_pct : nearer === null
  return {
    ...base,
    state: met ? 'met' : error_pct > 0 ? 'above' : 'below',
    actual,
    error_pct,
    lead_days: daysBetween(g.filed, actual.first_filed),
  }
}

export function guidanceTally(rows: readonly GroundTruthGuidance[]): GroundTruthGuidanceTally {
  const count = (state: GroundTruthGuidance['state']) =>
    rows.filter((r) => r.state === state).length
  const outside = rows.filter((r) => r.state === 'above' || r.state === 'below')
  return {
    figures: rows.length,
    scored: count('met') + outside.length,
    met: count('met'),
    above: count('above'),
    below: count('below'),
    open: count('open'),
    unsettled: count('unsettled'),
    median_miss_pct: outside.length ? middle(outside.map((r) => Math.abs(r.error_pct!))) : null,
  }
}

/** Per filer: how many releases we read, how many print a figure, and what it is compared with. */
export function guidanceFilers(
  reads: readonly { ticker: string; accession_no: string | null }[],
  guidance: readonly StoredGuidance[],
): GroundTruthGuidanceFiler[] {
  return (Object.keys(GUIDANCE_MEASURES) as ExposureTicker[]).map((ticker) => {
    const read = new Set(reads.filter((r) => r.ticker === ticker).map((r) => r.accession_no))
    const withFigure = new Set(
      guidance.filter((g) => g.ticker === ticker).map((g) => g.accession_no),
    )
    return {
      ticker,
      filer: FILER_NAMES[ticker],
      releases_read: read.size,
      releases_with_figure: withFigure.size,
      compared_with: GUIDANCE_MEASURES[ticker].compared_with,
      gap: GUIDANCE_MEASURES[ticker].gap,
    }
  })
}

/**
 * Every guidance figure, scored, newest release first. As of T it counts the
 * releases filed before T's UTC day, like the filed facts beside them.
 */
export async function queryGuidance(
  db: PipelineDb,
  at: string | null,
  facts: readonly StoredFact[],
  tolerance_pct: number,
): Promise<GroundTruthGuidanceData> {
  const [guidance, reads] = await Promise.all([
    db
      .select()
      .from(tables.filedGuidance)
      .where(
        and(
          eq(tables.filedGuidance.source, 'release'),
          at ? lt(tables.filedGuidance.filed, filedBefore(at)) : undefined,
        ),
      ),
    db
      .select({
        ticker: tables.filedFactReads.ticker,
        accession_no: tables.filedFactReads.accession_no,
      })
      .from(tables.filedFactReads)
      .where(
        and(
          eq(tables.filedFactReads.kind, 'release'),
          eq(tables.filedFactReads.status, 'ok'),
          at ? lte(tables.filedFactReads.started_at, at) : undefined,
        ),
      ),
  ])
  const rows = guidance
    .map((g) => scoreGuidance(g, facts, tolerance_pct))
    .sort(
      (a, b) =>
        b.filed.localeCompare(a.filed) ||
        a.ticker.localeCompare(b.ticker) ||
        a.fiscal_year - b.fiscal_year,
    )
  return {
    rows,
    tally: guidanceTally(rows),
    filers: guidanceFilers(reads, guidance),
    since: GUIDANCE_SINCE,
  }
}
