// What a company later filed for a guided metric and period, from XBRL.
//
// The figures come from EDGAR's company-concept API, one small document per
// filer and concept (data.sec.gov/api/xbrl/companyconcept/CIK…/us-gaap/Tag.json),
// stored as filed_facts rows with basis `companyconcept`. A guided figure is
// matched on concept and period:
//
//   revenue     total revenue, the first of REVENUE_CONCEPTS that has the period;
//   capex       the filer's own definition where the hyperscaler table holds one
//               (GUIDANCE_MEASURES: Meta adds finance-lease principal, Amazon's
//               net figure isn't scored), else purchases of property and equipment;
//   gross_margin GAAP gross profit over revenue, so only a GAAP guide is scored;
//   backlog     remaining performance obligations at the period's end;
//   growth      the period's revenue against the same period a year before
//               (or the quarter before, for a sequential guide).
//
// A quarter no filing reports on its own (most fourth quarters) is the year
// less the nine months, or a cash-flow quarter the year-to-date less the one
// before; the figure is public when the last of its parts was filed. A
// segment's revenue and an AI line aren't in the facts we read, so they stay
// unscored. Pure.

import type { ExposureTicker } from '../../shared/utils/terminal-exposure'
import { GUIDANCE_MEASURES } from '../utils/terminal-ground-truth-guidance'
import { daysBetween, fiscalPeriod, PERIOD_SLACK_DAYS, type FiscalPeriod } from './periods'

export const REVENUE_CONCEPTS = [
  'us-gaap:Revenues',
  'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
  'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax',
  'us-gaap:SalesRevenueNet',
] as const
export const PPE = 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment'
export const PRODUCTIVE = 'us-gaap:PaymentsToAcquireProductiveAssets'
export const GROSS_PROFIT = 'us-gaap:GrossProfit'
export const RPO = 'us-gaap:RevenueRemainingPerformanceObligation'

/** A single guided figure is met within this many percent; a guided percentage within half a point. */
export const ABOUT_TOLERANCE_PCT = 5
export const ABOUT_TOLERANCE_POINTS = 0.5
/** A dollar figure further than this from the filed total is some other measure, not a miss. */
export const NOT_SAME_MEASURE = 0.6
/** A guided percentage further than this many points from the filed one is some other measure too. */
export const NOT_SAME_POINTS = 20
/** A period ended this long ago with no filed figure is unscored, not open. */
export const NO_FILING_DAYS = 150

const EXPOSURE = new Set<string>(Object.keys(GUIDANCE_MEASURES))

/** The concepts a metric is scored from, for one ticker. Null when it isn't scored. */
export function conceptsFor(ticker: string, metric: string): string[] | null {
  switch (metric) {
    case 'revenue':
      return [...REVENUE_CONCEPTS]
    case 'capex': {
      if (EXPOSURE.has(ticker)) {
        const parts = GUIDANCE_MEASURES[ticker as ExposureTicker].parts
        return parts ? parts.map((p) => p.concept) : null
      }
      return [PPE, PRODUCTIVE]
    }
    case 'gross_margin':
      return [GROSS_PROFIT, ...REVENUE_CONCEPTS]
    case 'backlog':
      return [RPO]
    default:
      return null
  }
}

/**
 * Foreign private issuers: their quarters come in 6-Ks, which carry no XBRL,
 * so a quarterly figure has nothing to be scored against.
 */
export const FOREIGN_FILERS: ReadonlySet<string> = new Set(['TSM', 'ARM', 'NBIS', 'CLS'])

/** Why a statement can't be scored from what we read, or null when it can. */
export function unscorable(
  ticker: string,
  s: { metric: string; unit: string; basis: string | null; segment: string | null },
): string | null {
  if (FOREIGN_FILERS.has(ticker))
    return 'Files as a foreign private issuer: its quarters come in 6-Ks, with no XBRL to score against.'
  if (s.metric === 'segment_revenue') return 'A segment’s revenue isn’t in the filed facts we read.'
  if (s.metric === 'ai_revenue') return 'No filing states this AI figure as its own line.'
  if (s.metric === 'revenue' && s.basis === 'non_gaap')
    return 'Guided as non-GAAP revenue; filings print GAAP revenue only.'
  if (s.metric === 'gross_margin' && s.basis !== 'gaap')
    return 'Guided on a non-GAAP basis, or the basis isn’t stated; filings print GAAP only.'
  if (s.metric === 'capex' && conceptsFor(ticker, 'capex') === null)
    return 'Amazon guides net capex (purchases less proceeds and incentives); we read the gross line only.'
  if ((s.unit === 'growth_yoy' || s.unit === 'growth_qoq') && s.metric !== 'revenue')
    return 'Growth is scored on total revenue only.'
  return null
}

/** The subset of a filed_facts row the matcher reads. */
export interface ConceptFact {
  concept: string
  start: string | null
  end: string
  value: number
  form: string
  filed: string
  accession_no: string
  source_url: string
  fetched_at: string
}

interface CompanyConceptDoc {
  cik?: number | string
  taxonomy?: string
  tag?: string
  units?: Record<
    string,
    { start?: string; end: string; val: number; accn: string; form: string; filed: string }[]
  >
}

/** EDGAR's company-concept document, its USD facts from 10-Q/10-K/20-F/40-F filings. */
export function parseCompanyConcept(
  body: string,
  cik: string,
): Omit<ConceptFact, 'source_url' | 'fetched_at'>[] {
  const doc = JSON.parse(body) as CompanyConceptDoc
  if (!doc.units || !doc.tag) throw new Error('not an EDGAR company-concept document')
  if (Number(doc.cik) !== Number(cik)) throw new Error(`company concept is for CIK ${doc.cik}`)
  const concept = `${doc.taxonomy ?? 'us-gaap'}:${doc.tag}`
  return (doc.units.USD ?? [])
    .filter((f) => /^(?:10-[QK]|20-F|40-F)(?:\/A)?$/.test(f.form) && typeof f.val === 'number')
    .map((f) => ({
      concept,
      start: f.start ?? null,
      end: f.end,
      value: f.val,
      form: f.form,
      filed: f.filed,
      accession_no: f.accn,
    }))
}

/** A filed figure for a period: its value, and the filing that made it public. */
export interface Filed {
  value: number
  concept: string
  filed: string
  form: string
  accession_no: string
  source_url: string
  fetched_at: string
}

const near = (a: string | null, b: string) =>
  a !== null && Math.abs(daysBetween(a, b)) <= PERIOD_SLACK_DAYS

const firstFiled = (facts: readonly ConceptFact[]) =>
  [...facts].sort(
    (a, b) => a.filed.localeCompare(b.filed) || a.accession_no.localeCompare(b.accession_no),
  )[0]

const toFiled = (f: ConceptFact): Filed => ({
  value: f.value,
  concept: f.concept,
  filed: f.filed,
  form: f.form,
  accession_no: f.accession_no,
  source_url: f.source_url,
  fetched_at: f.fetched_at,
})

/** The later-public of two parts, carrying `value`. */
function combine(value: number, parts: readonly Filed[]): Filed {
  const last = parts.reduce((a, b) => (b.filed > a.filed ? b : a))
  return { ...last, value }
}

/** One concept's flow over [start, end], filed directly or derived from year-to-date figures. */
function flowOf(
  facts: readonly ConceptFact[],
  concept: string,
  fyEndMonth: number,
  p: FiscalPeriod,
): Filed | null {
  const of = facts.filter((f) => f.concept === concept)
  const span = (start: string, end: string) => {
    const f = firstFiled(of.filter((x) => near(x.start, start) && near(x.end, end)))
    return f ? toFiled(f) : null
  }
  const direct = span(p.start, p.end)
  if (direct || p.quarter === null) return direct
  const year = fiscalPeriod(fyEndMonth, p.fiscal_year, null)
  const ytd = span(year.start, p.end)
  if (p.quarter === 1) return ytd
  const before = fiscalPeriod(fyEndMonth, p.fiscal_year, p.quarter - 1)
  const ytdBefore = span(year.start, before.end)
  return ytd && ytdBefore ? combine(ytd.value - ytdBefore.value, [ytd, ytdBefore]) : null
}

export function instantOf(
  facts: readonly ConceptFact[],
  concept: string,
  end: string,
): Filed | null {
  const f = firstFiled(
    facts.filter((x) => x.concept === concept && x.start === null && near(x.end, end)),
  )
  return f ? toFiled(f) : null
}

/** Total revenue over a period, by the first concept that has it. */
export function revenueOf(
  facts: readonly ConceptFact[],
  fyEndMonth: number,
  p: FiscalPeriod,
): Filed | null {
  for (const c of REVENUE_CONCEPTS) {
    const v = flowOf(facts, c, fyEndMonth, p)
    if (v) return v
    // A fourth quarter not filed alone: the year less the first three.
    if (p.quarter === 4) {
      const year = flowOf(facts, c, fyEndMonth, fiscalPeriod(fyEndMonth, p.fiscal_year, null))
      const nine = [1, 2, 3].map((q) =>
        flowOf(facts, c, fyEndMonth, fiscalPeriod(fyEndMonth, p.fiscal_year, q)),
      )
      if (year && nine.every(Boolean)) {
        const parts = nine as Filed[]
        return combine(year.value - parts.reduce((s, x) => s + x.value, 0), [year, ...parts])
      }
    }
  }
  return null
}

export function flowSum(
  facts: readonly ConceptFact[],
  concepts: readonly string[],
  fyEndMonth: number,
  p: FiscalPeriod,
): Filed | null {
  const parts: Filed[] = []
  for (const c of concepts) {
    let v = flowOf(facts, c, fyEndMonth, p)
    if (!v && p.quarter === 4) {
      const year = flowOf(facts, c, fyEndMonth, fiscalPeriod(fyEndMonth, p.fiscal_year, null))
      const nine = flowOf(facts, c, fyEndMonth, {
        ...fiscalPeriod(fyEndMonth, p.fiscal_year, 3),
        start: fiscalPeriod(fyEndMonth, p.fiscal_year, null).start,
      })
      if (year && nine) v = combine(year.value - nine.value, [year, nine])
    }
    if (!v) return null
    parts.push(v)
  }
  return combine(
    parts.reduce((s, x) => s + x.value, 0),
    parts,
  )
}

/** The filed figure a statement is scored against, in the statement's unit, or null until filed. */
export function actualFor(
  ticker: string,
  s: { metric: string; unit: string },
  p: FiscalPeriod,
  fyEndMonth: number,
  facts: readonly ConceptFact[],
): Filed | null {
  if (s.unit === 'growth_yoy' || s.unit === 'growth_qoq') {
    const now = revenueOf(facts, fyEndMonth, p)
    if (!now) return null
    const prior =
      s.unit === 'growth_yoy'
        ? fiscalPeriod(fyEndMonth, p.fiscal_year - 1, p.quarter)
        : p.quarter === 1 || p.quarter === null
          ? null
          : fiscalPeriod(fyEndMonth, p.fiscal_year, p.quarter - 1)
    const q1Prior =
      s.unit === 'growth_qoq' && p.quarter === 1
        ? fiscalPeriod(fyEndMonth, p.fiscal_year - 1, 4)
        : null
    const then = revenueOf(facts, fyEndMonth, (prior ?? q1Prior)!)
    if (!then || then.value <= 0) return null
    return { ...now, value: (now.value / then.value - 1) * 100 }
  }
  switch (s.metric) {
    case 'revenue':
      return revenueOf(facts, fyEndMonth, p)
    case 'capex': {
      const concepts = conceptsFor(ticker, 'capex')
      if (!concepts) return null
      // Meta's measure is the sum of its parts; anyone else's is the first concept it files.
      if (concepts.length > 1 && EXPOSURE.has(ticker))
        return flowSum(facts, concepts, fyEndMonth, p)
      for (const c of concepts) {
        const v = flowSum(facts, [c], fyEndMonth, p)
        if (v) return v
      }
      return null
    }
    case 'gross_margin': {
      const gp = flowSum(facts, [GROSS_PROFIT], fyEndMonth, p)
      const rev = revenueOf(facts, fyEndMonth, p)
      if (!gp || !rev || rev.value <= 0) return null
      return combine((gp.value / rev.value) * 100, [gp, rev])
    }
    case 'backlog':
      return instantOf(facts, RPO, p.end)
    default:
      return null
  }
}

export type ScoreState = 'met' | 'above' | 'below'

/** The guided figure against the filed one: a state, and the error as a share. */
export function score(
  g: { low: number; high: number; bound: string; unit: string },
  actual: number,
): { state: ScoreState; error_share: number; guided_mid: number } | null {
  const mid = (g.low + g.high) / 2
  const dollars = g.unit === 'USD'
  const error_share = dollars ? (actual - mid) / mid : (actual - mid) / 100
  if (dollars && Math.abs(error_share) > NOT_SAME_MEASURE) return null
  if (!dollars && Math.abs(actual - mid) > NOT_SAME_POINTS) return null
  let met: boolean
  switch (g.bound) {
    case 'range':
      met = actual >= g.low && actual <= g.high
      break
    case 'at_least':
      met = actual >= g.low
      break
    case 'at_most':
      met = actual <= g.high
      break
    default:
      met = dollars
        ? Math.abs(error_share) * 100 <= ABOUT_TOLERANCE_PCT
        : Math.abs(actual - mid) <= ABOUT_TOLERANCE_POINTS
  }
  const state: ScoreState = met ? 'met' : actual > mid ? 'above' : 'below'
  return { state, error_share, guided_mid: mid }
}

/** Every concept the open statements of a ticker need read. */
export function neededConcepts(
  ticker: string,
  statements: readonly { metric: string; unit: string }[],
): string[] {
  const out = new Set<string>()
  for (const s of statements) {
    const metric = s.unit === 'growth_yoy' || s.unit === 'growth_qoq' ? 'revenue' : s.metric
    for (const c of conceptsFor(ticker, metric) ?? []) out.add(c)
  }
  return [...out]
}

/** EDGAR's company-concept URL for one filer and us-gaap concept. */
export const conceptUrl = (cik: string, concept: string) =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${concept.replace(':', '/')}.json`
