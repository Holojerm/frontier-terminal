// The dependency graph: who the labs buy from and who funds them, built from
// two payloads the site already serves. Lines come from /api/exposure (what a
// public company's XBRL tags on a named counterparty). Node sizes come from
// each company's own filing: a filer's backlog and capex from the same
// series, a lab's aggregate obligations from its prospectus (/api/prospectus).
//
// Nothing here is estimated, and no press-reported deal is drawn. A line
// exists only where a filing names the counterparty, so the figure a reader
// expects and doesn't see is listed as a gap with the reason.

import type {
  DependenciesData,
  DependencyEdge,
  DependencyFigure,
  DependencyGap,
  DependencyKind,
  DependencyNode,
} from '../../shared/utils/terminal-dependencies'
import type {
  ExposureData,
  ExposureSeries,
  ExposureTicker,
} from '../../shared/utils/terminal-exposure'
import { labName } from '#layers/core/shared/utils/lab-names'
import type { ProspectusData } from '../../shared/utils/terminal-prospectus'

import type { PipelineDb } from '#layers/core/server/pipeline/store'
import type { QueryContext } from '#layers/core/server/utils/terminal-db'
import { queryExposure } from './terminal-exposure'
import { queryProspectus } from './terminal-prospectus'
import { PROVIDER_ORDER } from '#layers/core/server/utils/terminal-sources'

export const DEPENDENCIES_RULE =
  'Filed figures only. A line is a number one company’s SEC filing puts on another, read from the filer’s XBRL (the SEC’s tagged financial data). A circle is sized by the company’s own filed figure. Deals reported in the press aren’t drawn. Not investment advice.'

const RPO = 'us-gaap:RevenueRemainingPerformanceObligation'

/**
 * Where each concept a filer tags on a counterparty goes: which line, the
 * words for its label, and its rank. The lowest-ranked dollar figure on a
 * line sets the line's width. A concept missing here is left off the graph
 * and reported as unplaced, never guessed onto a line.
 */
const PLACEMENT: Readonly<Record<string, { kind: DependencyKind; short: string; rank: number }>> = {
  [RPO]: { kind: 'buys', short: 'backlog', rank: 0 },
  'amzn:RevenueRemainingPerformanceObligationAmountPeriodIncreaseDecrease': {
    kind: 'buys',
    short: 'added to backlog',
    rank: 1,
  },
  'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax': {
    kind: 'buys',
    short: 'revenue',
    rank: 2,
  },
  'us-gaap:AccountsReceivableNet': { kind: 'buys', short: 'receivables', rank: 3 },
  'msft:EquityMethodInvestmentsTotalFundingCommitments': {
    kind: 'funds',
    short: 'committed',
    rank: 0,
  },
  'us-gaap:LineOfCreditFacilityMaximumBorrowingCapacity': {
    kind: 'funds',
    short: 'credit line',
    rank: 1,
  },
  'msft:EquityMethodInvestmentsFunded': { kind: 'funds', short: 'paid in', rank: 2 },
  'us-gaap:LineOfCreditFacilityCurrentBorrowingCapacity': {
    kind: 'funds',
    short: 'credit available',
    rank: 3,
  },
  'us-gaap:EquitySecuritiesWithoutReadilyDeterminableFairValueUpwardPriceAdjustmentAnnualAmount': {
    kind: 'funds',
    short: 'upward marks',
    rank: 4,
  },
  'us-gaap:NonoperatingIncomeExpense': { kind: 'funds', short: 'gain or loss', rank: 5 },
  'us-gaap:EquityMethodInvestmentOwnershipPercentage': { kind: 'funds', short: 'stake', rank: 6 },
  'msft:InvestmentOwnershipPercentage': { kind: 'funds', short: 'stake', rank: 7 },
  'us-gaap:InvestmentOwnedBalanceShares': { kind: 'funds', short: 'shares held', rank: 8 },
}

/** Series outside the two lab groups that name a counterparty, by series id. */
const COUNTERPARTY_SERIES: Readonly<Record<string, string>> = {
  'amzn-rpo-openai': 'openai',
  'googl-rpo-investee': 'crux-ai',
}

/** Counterparties a filing names that aren't a tracked lab. */
const VENTURES: Readonly<Record<string, string>> = { 'crux-ai': 'Crux AI' }

/** The filers that are, or own, a tracked lab. */
const FILER_LABS: Readonly<Partial<Record<ExposureTicker, string>>> = {
  GOOGL: 'google',
  META: 'meta',
}

/** The filers down the right of the graph, top to bottom. */
const FILER_ORDER: readonly ExposureTicker[] = ['MSFT', 'AMZN', 'GOOGL', 'META', 'ORCL']

function figureOf(s: ExposureSeries, short: string): DependencyFigure | null {
  const p = s.points.at(-1)
  if (!p) return null
  return {
    series_id: s.id,
    label: s.label,
    short,
    value: p.value,
    unit: s.unit,
    start: p.start,
    end: p.end,
    months: p.months,
    derived: p.derived,
    approximate: false,
    note: s.note,
    accession_no: p.accession_no,
    form: p.form,
    filed: p.filed,
    filing_url: p.filing_url,
    source_url: p.source_url,
    fetched_at: p.fetched_at,
  }
}

/** Which counterparty a series is about, or null for a filer's own line. */
function counterpartyOf(s: ExposureSeries): string | null {
  if (s.group === 'openai' || s.group === 'anthropic') return s.group
  return COUNTERPARTY_SERIES[s.id] ?? null
}

const list = (names: string[]) =>
  names.length < 3
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`

/**
 * The graph's lines, from the exposure series alone: one per (filer,
 * counterparty, kind), holding every placed figure. The dependency_edges
 * export is these, one row per figure.
 */
export function dependencyEdges(
  series: readonly ExposureSeries[],
): Pick<DependenciesData, 'edges' | 'unplaced'> {
  type Line = DependencyEdge & { ranks: Map<DependencyFigure, number> }
  const lines = new Map<string, Line>()
  const unplaced: DependenciesData['unplaced'] = []
  for (const s of series) {
    const other = counterpartyOf(s)
    if (!other) continue
    const place = PLACEMENT[s.concept]
    const figure = place ? figureOf(s, place.short) : null
    if (!place || !figure) {
      if (!place) unplaced.push({ series_id: s.id, ticker: s.ticker, label: s.label })
      continue
    }
    const [from, to] = place.kind === 'buys' ? [other, s.ticker] : [s.ticker, other]
    const id = `${from}>${to}:${place.kind}`
    const line: Line = lines.get(id) ?? {
      id,
      from,
      to,
      kind: place.kind,
      reporter: s.ticker,
      weight: null,
      facts: [],
      ranks: new Map(),
    }
    line.facts.push(figure)
    line.ranks.set(figure, place.rank)
    lines.set(id, line)
  }
  const edges: DependencyEdge[] = [...lines.values()].map(({ ranks, ...line }) => {
    // By rank, then the newer period: a subsequent-event figure sits under the period's own.
    const facts = [...line.facts].sort(
      (a, b) => ranks.get(a)! - ranks.get(b)! || (a.end! < b.end! ? 1 : a.end! > b.end! ? -1 : 0),
    )
    return { ...line, facts, weight: facts.find((f) => f.unit === 'USD' && f.value > 0) ?? null }
  })
  const order = (id: string) => {
    const t = FILER_ORDER.indexOf(id as ExposureTicker)
    return t === -1 ? FILER_ORDER.length : t
  }
  edges.sort(
    (a, b) =>
      order(a.reporter) - order(b.reporter) ||
      (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'buys' ? -1 : 1),
  )
  return { edges, unplaced }
}

/** The graph of two payloads. Pure: the same inputs give the same graph. */
export function buildDependencies(
  exposure: ExposureData,
  prospectus: ProspectusData,
): Pick<DependenciesData, 'nodes' | 'edges' | 'gaps' | 'unplaced'> {
  const tickers = FILER_ORDER.filter((t) => exposure.filers.some((f) => f.ticker === t))
  const byId = new Map(exposure.series.map((s) => [s.id, s]))
  const { edges, unplaced } = dependencyEdges(exposure.series)

  // Nodes: every filer, then each counterparty a line names.
  const obligations = (lab: string): DependencyFigure | null => {
    const issuer = prospectus.issuers.find((i) => i.provider === lab)
    const c = issuer?.commitments.find((x) => x.schedule === 'obligations_aggregate')
    const line = c?.lines[0]
    if (!c || !line) return null
    return {
      series_id: null,
      label: 'Contractual obligations, in aggregate',
      short: 'obligations',
      value: line.total,
      unit: 'USD',
      start: null,
      end: c.as_of,
      months: null,
      derived: false,
      approximate: c.approximate,
      note: c.statement,
      accession_no: c.accession_no,
      form: c.form,
      filed: c.filed,
      filing_url: c.filing_url,
      source_url: c.source_url,
      fetched_at: c.fetched_at,
    }
  }
  const own = (id: string, short: string) => {
    const s = byId.get(id)
    return s ? figureOf(s, short) : null
  }
  const nodes: DependencyNode[] = []
  const others = [...new Set(edges.map((e) => (e.kind === 'buys' ? e.from : e.to)))]
  const labs = PROVIDER_ORDER.filter((p) => others.includes(p))
  for (const lab of labs) {
    nodes.push({
      id: lab,
      kind: 'lab',
      name: labName(lab),
      ticker: null,
      lab,
      contracts: obligations(lab),
      capex: null,
    })
  }
  for (const id of others.filter((o) => !(labs as string[]).includes(o))) {
    nodes.push({
      id,
      kind: 'venture',
      name: VENTURES[id] ?? id,
      ticker: null,
      lab: null,
      contracts: null,
      capex: null,
    })
  }
  for (const t of tickers) {
    const filer = exposure.filers.find((f) => f.ticker === t)!
    nodes.push({
      id: t,
      kind: 'filer',
      name: filer.name,
      ticker: t,
      lab: FILER_LABS[t] ?? null,
      contracts: own(`${t.toLowerCase()}-rpo`, 'backlog'),
      capex: own(`${t.toLowerCase()}-capex`, 'capex'),
    })
  }

  // Gaps: what a reader would look for and no filing we read gives.
  const gaps: DependencyGap[] = []
  for (const n of nodes) {
    if (n.kind === 'filer') continue
    if (n.contracts) {
      gaps.push({
        id: `${n.id}-suppliers`,
        title: `${n.name}’s filing names no supplier for its obligations`,
        reason: `It gives one total, so the circle is sized by it and no line is drawn from it. The filing says: “${n.contracts.note ?? ''}”`,
      })
    } else {
      gaps.push({
        id: `${n.id}-unfiled`,
        title: `${n.name} has no filing of its own here`,
        reason: `We have read no SEC filing by ${n.name}, so its circle has no size. Every figure on its lines is the other company’s.`,
      })
    }
  }
  for (const g of exposure.gaps) gaps.push({ id: g.id, title: g.title, reason: g.reason })
  const silent = nodes.filter(
    (n) => n.kind === 'filer' && !edges.some((e) => e.from === n.id || e.to === n.id),
  )
  if (silent.length) {
    gaps.push({
      id: 'filers-without-lines',
      title: `${list(silent.map((n) => n.name))} ${silent.length === 1 ? 'has' : 'have'} no line`,
      reason: `None of the facts we read from ${silent.length === 1 ? 'its' : 'their'} filings names a lab or another counterparty.`,
    })
  }
  const drawn = new Set(nodes.map((n) => n.lab).filter(Boolean))
  const absent = PROVIDER_ORDER.filter((p) => !drawn.has(p))
  if (absent.length) {
    gaps.push({
      id: 'labs-not-drawn',
      title: `${list(absent.map(labName))} ${absent.length === 1 ? 'isn’t' : 'aren’t'} drawn`,
      reason: `No fact in the filings of ${list(tickers.map((t) => exposure.filers.find((f) => f.ticker === t)!.name))} names ${absent.length === 1 ? 'it' : 'them'}.`,
    })
  }
  gaps.push({
    id: 'suppliers-in-table',
    title: 'Chip and compute suppliers are in the table, with no circle',
    reason:
      'The graph draws what these companies tag in their XBRL and what a lab’s prospectus states. A chip maker’s tie to a lab is a sentence in its filing, read by hand, so it is a row in the suppliers table with its quote. The companies that power each lab’s sites are on the Compute page. The listed-companies table has every ticker from all three.',
  })

  return { nodes, edges, gaps, unplaced }
}

export async function queryDependencies(
  db: PipelineDb,
  ctx: QueryContext,
): Promise<DependenciesData> {
  const [exposure, prospectus] = await Promise.all([
    queryExposure(db, ctx),
    queryProspectus(db, ctx),
  ])
  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    rule: DEPENDENCIES_RULE,
    ...buildDependencies(exposure, prospectus),
  }
}
