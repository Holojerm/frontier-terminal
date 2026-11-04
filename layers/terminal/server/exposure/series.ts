// What the filed facts are turned into: one quarterly series per filer and
// line, oldest first, each point from the newest filing that reported it.
//
// A cash-flow line is tagged year to date (a 10-Q's six or nine months, a
// 10-K's year), so a quarter is read directly where the filing tags three
// months and otherwise derived as the year-to-date figure less the one a
// quarter shorter, and marked derived with the figure it took away. A
// balance (backlog, a stake) is read at each period end. A value a later
// filing restated is kept as superseded, never dropped.
//
// Every series is the filer's number. Microsoft's line on OpenAI is what
// Microsoft recognized, not OpenAI's result, and Amazon's upward marks follow
// observable prices for its preferred stock, not Anthropic's valuation.

import type {
  ExposureGap,
  ExposureGroup,
  ExposurePoint,
  ExposureSeries,
  ExposureSuperseded,
  ExposureTicker,
} from '../../shared/utils/terminal-exposure'

/** The subset of a filed_facts row the series read. */
export interface StoredFact {
  ticker: string
  concept: string
  dims: string
  start: string | null
  end: string
  value: number
  unit: string
  form: string
  filed: string
  accession_no: string
  cik: string
  source_url: string
  fetched_at: string
}

/** Series start here: the first quarter ending in 2020. */
export const SERIES_SINCE = '2020-01-01'

export const FILER_NAMES: Readonly<Record<ExposureTicker, string>> = {
  MSFT: 'Microsoft',
  GOOGL: 'Alphabet',
  AMZN: 'Amazon',
  META: 'Meta',
  ORCL: 'Oracle',
}

export const FISCAL_YEAR_END: Readonly<Record<ExposureTicker, string>> = {
  MSFT: 'June 30',
  GOOGL: 'December 31',
  AMZN: 'December 31',
  META: 'December 31',
  ORCL: 'May 31',
}

/**
 * The investee members read off each instance, and the lab each one is.
 * Facts on these become the openai and anthropic groups, one series per
 * concept (and any other dimension beside the member).
 */
export const LAB_MEMBERS: Readonly<
  Record<string, { ticker: ExposureTicker; lab: 'openai' | 'anthropic' }>
> = {
  'msft:OpenAIGlobalLlcMember': { ticker: 'MSFT', lab: 'openai' },
  'amzn:AnthropicMember': { ticker: 'AMZN', lab: 'anthropic' },
}

/** Lab-group series that raise an alert when a new filing moves them. */
export const ALERTING_LAB_CONCEPTS = [
  'us-gaap:NonoperatingIncomeExpense',
  'us-gaap:EquitySecuritiesWithoutReadilyDeterminableFairValueUpwardPriceAdjustmentAnnualAmount',
] as const

interface SeriesDef {
  id: string
  ticker: ExposureTicker
  group: ExposureGroup
  chart: string
  label: string
  concept: string
  /** Which contexts the series reads, by their dims string and period end. */
  dims: string | ((dims: string, end: string) => boolean)
  kind: 'flow' | 'balance'
  note?: string
  alert?: boolean
}

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

const PPE = 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment'
const RPO = 'us-gaap:RevenueRemainingPerformanceObligation'
const RPO_START =
  'us-gaap:RevenueRemainingPerformanceObligationExpectedTimingOfSatisfactionStartDateAxis'

/**
 * Amazon tags its total backlog on a typed timing axis since the third
 * quarter of 2020: the amount expected from the day after the period end,
 * which is all of it. Before that it was a plain fact.
 */
const amazonTotal = (dims: string, end: string) =>
  dims === '' || dims === `${RPO_START}=${nextDay(end)}`

export const SERIES_DEFS: readonly SeriesDef[] = [
  {
    id: 'msft-capex',
    ticker: 'MSFT',
    group: 'capex',
    chart: 'msft-capex',
    label: 'Additions to property and equipment',
    concept: PPE,
    dims: '',
    kind: 'flow',
    alert: true,
    note: 'Cash spent. Microsoft also signs finance leases for data centers, which aren’t in this line. We show them as a second line and don’t add the two.',
  },
  {
    id: 'msft-finance-leases',
    ticker: 'MSFT',
    group: 'capex',
    chart: 'msft-capex',
    label: 'Finance leases signed',
    concept: 'us-gaap:RightOfUseAssetObtainedInExchangeForFinanceLeaseLiability',
    dims: '',
    kind: 'flow',
    note: 'Right-of-use assets obtained in exchange for finance lease liabilities. No cash changes hands when one is signed.',
  },
  {
    id: 'googl-capex',
    ticker: 'GOOGL',
    group: 'capex',
    chart: 'googl-capex',
    label: 'Purchases of property and equipment',
    concept: PPE,
    dims: '',
    kind: 'flow',
    alert: true,
  },
  {
    id: 'amzn-capex',
    ticker: 'AMZN',
    group: 'capex',
    chart: 'amzn-capex',
    label: 'Purchases of property and equipment',
    concept: 'us-gaap:PaymentsToAcquireProductiveAssets',
    dims: '',
    kind: 'flow',
    alert: true,
    note: 'Gross of the proceeds and incentives Amazon reports on its own line. Assets under finance leases aren’t in it.',
  },
  {
    id: 'meta-capex',
    ticker: 'META',
    group: 'capex',
    chart: 'meta-capex',
    label: 'Purchases of property and equipment',
    concept: PPE,
    dims: '',
    kind: 'flow',
    alert: true,
    note: 'Meta’s own capex figure adds its principal payments on finance leases, the second line here. We don’t add them.',
  },
  {
    id: 'meta-finance-lease-principal',
    ticker: 'META',
    group: 'capex',
    chart: 'meta-capex',
    label: 'Principal payments on finance leases',
    concept: 'us-gaap:FinanceLeasePrincipalPayments',
    dims: '',
    kind: 'flow',
  },
  {
    id: 'orcl-capex',
    ticker: 'ORCL',
    group: 'capex',
    chart: 'orcl-capex',
    label: 'Capital expenditures',
    concept: PPE,
    dims: '',
    kind: 'flow',
    alert: true,
    note: 'Oracle’s fiscal year ends May 31, so its quarters end in August, November, February, and May.',
  },
  {
    id: 'msft-rpo',
    ticker: 'MSFT',
    group: 'rpo',
    chart: 'msft-rpo',
    label: 'Remaining performance obligations',
    concept: RPO,
    dims: '',
    kind: 'balance',
    alert: true,
  },
  {
    id: 'msft-rpo-commercial',
    ticker: 'MSFT',
    group: 'rpo',
    chart: 'msft-rpo',
    label: 'Commercial remaining performance obligations',
    concept: RPO,
    dims: 'srt:MajorCustomersAxis=msft:CommercialCustomersMember',
    kind: 'balance',
    alert: true,
    note: 'Microsoft tags commercial backlog. It doesn’t tag a Microsoft Cloud figure.',
  },
  {
    id: 'googl-rpo',
    ticker: 'GOOGL',
    group: 'rpo',
    chart: 'googl-rpo',
    label: 'Remaining performance obligations',
    concept: RPO,
    dims: '',
    kind: 'balance',
    alert: true,
    note: 'From the first quarter of 2026 Alphabet also counts contracts of a year or less, so later quarters aren’t comparable with earlier ones.',
  },
  {
    id: 'googl-rpo-cloud',
    ticker: 'GOOGL',
    group: 'rpo',
    chart: 'googl-rpo',
    label: 'Google Cloud remaining performance obligations',
    concept: RPO,
    dims: 'us-gaap:StatementBusinessSegmentsAxis=goog:GoogleCloudMember',
    kind: 'balance',
    alert: true,
    note: 'Alphabet started tagging the Google Cloud figure recently. Earlier quarters tag only the total.',
  },
  {
    id: 'googl-rpo-investee',
    ticker: 'GOOGL',
    group: 'rpo',
    chart: 'googl-rpo',
    label: 'Backlog from Crux AI',
    concept: RPO,
    dims: 'us-gaap:RelatedPartyTransactionsByRelatedPartyAxis=us-gaap:EquityMethodInvesteeMember',
    kind: 'balance',
    note: 'Alphabet tags it as backlog from an equity-method investee. Its 10-Q text names the investee as Crux AI, a joint venture and related party.',
  },
  {
    id: 'amzn-rpo',
    ticker: 'AMZN',
    group: 'rpo',
    chart: 'amzn-rpo',
    label: 'Remaining performance obligations',
    concept: RPO,
    dims: amazonTotal,
    kind: 'balance',
    alert: true,
    note: 'Amazon’s total, which its 10-Q says is mainly AWS. It doesn’t tag an AWS-only figure.',
  },
  {
    id: 'amzn-rpo-openai',
    ticker: 'AMZN',
    group: 'rpo',
    chart: 'amzn-rpo',
    label: 'Backlog from OpenAI',
    concept: RPO,
    dims: (dims) => dims.split(';').includes('srt:MajorCustomersAxis=amzn:OpenAIGroupPBCMember'),
    kind: 'balance',
  },
  {
    id: 'orcl-rpo',
    ticker: 'ORCL',
    group: 'rpo',
    chart: 'orcl-rpo',
    label: 'Remaining performance obligations',
    concept: RPO,
    dims: '',
    kind: 'balance',
    alert: true,
    note: 'Oracle tags only its total backlog. It doesn’t tag a cloud figure.',
  },
]

/** Plain names for the concepts the parents tag on a lab, by concept. */
/** Plain names for the concepts a parent tags on a lab, by `<lab>|<concept>`. */
const LAB_LABELS: Readonly<Record<string, string>> = {
  'openai|us-gaap:NonoperatingIncomeExpense': 'Gain or loss Microsoft recognized on OpenAI',
  'openai|us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax': 'Revenue from OpenAI',
  'openai|us-gaap:AccountsReceivableNet': 'Receivables from OpenAI',
  'openai|msft:EquityMethodInvestmentsTotalFundingCommitments': 'Total funding commitment',
  'openai|msft:EquityMethodInvestmentsFunded': 'Funding paid in',
  'openai|us-gaap:EquityMethodInvestmentOwnershipPercentage': 'Ownership stake',
  'anthropic|us-gaap:EquitySecuritiesWithoutReadilyDeterminableFairValueUpwardPriceAdjustmentAnnualAmount':
    'Upward marks on the Anthropic preferred stock',
  'anthropic|us-gaap:InvestmentOwnedBalanceShares': 'Anthropic shares held',
  'anthropic|amzn:RevenueRemainingPerformanceObligationAmountPeriodIncreaseDecrease':
    'Commitment Anthropic added to Amazon’s backlog',
  'anthropic|us-gaap:LineOfCreditFacilityMaximumBorrowingCapacity':
    'Financing Amazon makes available to Anthropic, maximum',
  'anthropic|us-gaap:LineOfCreditFacilityCurrentBorrowingCapacity':
    'Financing available to Anthropic now',
}

const LAB_NOTES: Readonly<Record<string, string>> = {
  'openai|us-gaap:NonoperatingIncomeExpense':
    'This is Microsoft’s figure. It isn’t OpenAI’s result. Microsoft books its share of OpenAI’s results and dilution gains in this line, and they can lag a quarter.',
  'anthropic|us-gaap:EquitySecuritiesWithoutReadilyDeterminableFairValueUpwardPriceAdjustmentAnnualAmount':
    'These are Amazon’s marks. They aren’t Anthropic’s valuation, and they follow observable prices for the same or similar shares.',
}

const localName = (qname: string) => qname.slice(qname.indexOf(':') + 1)

/** `PaymentsToAcquireThing` → `Payments to acquire thing`. */
export function humanize(concept: string): string {
  const words = localName(concept)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const slug = (s: string) =>
  localName(s)
    .replace(/Member$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()

/** EDGAR's filing index for an accession. */
export function filingUrl(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/`
}

const days = (start: string, end: string) =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1

const isQuarter = (d: number) => d >= 80 && d <= 100

/** Newest filing first; within a filing date the later accession. */
const newer = (a: StoredFact, b: StoredFact) =>
  a.filed !== b.filed ? (a.filed > b.filed ? -1 : 1) : a.accession_no > b.accession_no ? -1 : 1

const filingOf = (f: StoredFact) => ({
  accession_no: f.accession_no,
  form: f.form,
  filed: f.filed,
  filing_url: filingUrl(f.cik, f.accession_no),
})

/** Per period, the newest filing's fact; the rest that differ from it, as superseded. */
function current(facts: readonly StoredFact[]): {
  byPeriod: Map<string, StoredFact>
  superseded: ExposureSuperseded[]
} {
  const groups = new Map<string, StoredFact[]>()
  for (const f of facts) {
    const k = `${f.start ?? ''}|${f.end}`
    groups.set(k, [...(groups.get(k) ?? []), f])
  }
  const byPeriod = new Map<string, StoredFact>()
  const superseded: ExposureSuperseded[] = []
  for (const [k, group] of groups) {
    const sorted = [...group].sort(newer)
    const top = sorted[0]!
    byPeriod.set(k, top)
    const seen = new Set<string>()
    for (const f of sorted.slice(1)) {
      if (f.value === top.value || seen.has(f.accession_no)) continue
      seen.add(f.accession_no)
      superseded.push({
        ...filingOf(f),
        start: f.start,
        end: f.end,
        value: f.value,
        replaced_by: top.accession_no,
        source_url: f.source_url,
        fetched_at: f.fetched_at,
      })
    }
  }
  superseded.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : a.filed < b.filed ? -1 : 1))
  return { byPeriod, superseded }
}

/** A period's length in whole months: 3 for a quarter, 9 for nine months; null for a balance. */
export const monthsOf = (start: string | null, end: string) =>
  start === null ? null : Math.round(days(start, end) / 30.44)

const point = (f: StoredFact, extra: Partial<ExposurePoint> = {}): ExposurePoint => {
  const p = {
    ...filingOf(f),
    start: f.start,
    end: f.end,
    value: f.value,
    derived: false,
    less: null,
    source_url: f.source_url,
    fetched_at: f.fetched_at,
    ...extra,
  }
  return { ...p, months: monthsOf(p.start, p.end) }
}

/**
 * Quarterly points for a flow: three-month facts as tagged, the rest derived
 * from year-to-date pairs. A period end no quarter can be found for keeps
 * its longest fact as tagged (Amazon tags its Anthropic marks for nine months
 * only), with `months` saying how long it is.
 */
export function quarterly(byPeriod: ReadonlyMap<string, StoredFact>): ExposurePoint[] {
  const facts = [...byPeriod.values()].filter((f) => f.start !== null)
  const out = new Map<string, ExposurePoint>()
  for (const f of facts) {
    if (isQuarter(days(f.start!, f.end))) out.set(f.end, point(f))
  }
  for (const f of facts) {
    if (out.has(f.end) || days(f.start!, f.end) <= 100) continue
    // The same year to date, one quarter shorter.
    const shorter = facts
      .filter((g) => g.start === f.start && g.end < f.end && isQuarter(days(nextDay(g.end), f.end)))
      .sort((a, b) => (a.end < b.end ? 1 : -1))[0]
    if (!shorter) continue
    out.set(
      f.end,
      point(f, {
        start: nextDay(shorter.end),
        value: f.value - shorter.value,
        derived: true,
        less: {
          ...filingOf(shorter),
          start: shorter.start,
          end: shorter.end,
          value: shorter.value,
        },
      }),
    )
  }
  for (const f of [...facts].sort((a, b) => days(b.start!, b.end) - days(a.start!, a.end))) {
    if (!out.has(f.end)) out.set(f.end, point(f))
  }
  return [...out.values()].sort((a, b) => (a.end < b.end ? -1 : 1))
}

function balances(byPeriod: ReadonlyMap<string, StoredFact>): ExposurePoint[] {
  return [...byPeriod.values()]
    .filter((f) => f.start === null)
    .map((f) => point(f))
    .sort((a, b) => (a.end < b.end ? -1 : 1))
}

function build(
  def: Omit<SeriesDef, 'dims' | 'note'> & { dims: string; unit: string; note: string | null },
  facts: readonly StoredFact[],
): ExposureSeries {
  const { byPeriod, superseded } = current(facts)
  const points = (def.kind === 'flow' ? quarterly(byPeriod) : balances(byPeriod)).filter(
    (p) => p.end >= SERIES_SINCE,
  )
  return {
    id: def.id,
    ticker: def.ticker,
    filer: FILER_NAMES[def.ticker],
    group: def.group,
    chart: def.chart,
    label: def.label,
    concept: def.concept,
    dims: def.dims,
    kind: def.kind,
    unit: def.unit,
    note: def.note,
    points,
    superseded: superseded.filter((s) => s.end >= SERIES_SINCE),
  }
}

/**
 * The dims string without the pair that names `member`, and without the RPO
 * timing axis, whose value is a date that moves with every period.
 */
const withoutMember = (dims: string, member: string) =>
  dims
    .split(';')
    .filter((d) => d && !d.endsWith(`=${member}`) && !d.startsWith(`${RPO_START}=`))
    .join(';')

/** Every series, fixed ones first in SERIES_DEFS order, then the lab groups by first period. */
export function buildSeries(facts: readonly StoredFact[]): ExposureSeries[] {
  const byTicker = new Map<string, StoredFact[]>()
  for (const f of facts) byTicker.set(f.ticker, [...(byTicker.get(f.ticker) ?? []), f])

  const out: ExposureSeries[] = []
  for (const def of SERIES_DEFS) {
    const match = (f: StoredFact) =>
      f.concept === def.concept &&
      f.unit === 'USD' &&
      (typeof def.dims === 'string' ? f.dims === def.dims : def.dims(f.dims, f.end))
    const mine = (byTicker.get(def.ticker) ?? []).filter(match)
    const series = build(
      {
        ...def,
        dims: typeof def.dims === 'string' ? def.dims : '',
        unit: 'USD',
        note: def.note ?? null,
      },
      mine,
    )
    if (typeof def.dims !== 'string')
      series.dims = [...new Set(mine.map((f) => f.dims))].join(' | ')
    if (series.points.length) out.push(series)
  }

  for (const [member, { ticker, lab }] of Object.entries(LAB_MEMBERS)) {
    const groups = new Map<string, StoredFact[]>()
    for (const f of byTicker.get(ticker) ?? []) {
      if (!f.dims.split(';').some((d) => d.endsWith(`=${member}`))) continue
      const k = `${f.concept}|${withoutMember(f.dims, member)}|${f.unit}`
      groups.set(k, [...(groups.get(k) ?? []), f])
    }
    const labSeries: ExposureSeries[] = []
    for (const [k, group] of groups) {
      const [concept, others, unit] = k.split('|') as [string, string, string]
      const kind = group.some((f) => f.start !== null) ? 'flow' : 'balance'
      const id = [
        ticker.toLowerCase(),
        lab,
        slug(concept),
        ...others
          .split(';')
          .filter(Boolean)
          .map((d) => slug(d.split('=')[1]!)),
      ].join('-')
      const series = build(
        {
          id,
          ticker,
          group: lab,
          chart: id,
          label:
            (LAB_LABELS[`${lab}|${concept}`] ?? humanize(concept)) +
            (others.includes('SubsequentEventMember') ? ', after the period end' : ''),
          concept,
          dims: '',
          kind,
          unit,
          note: LAB_NOTES[`${lab}|${concept}`] ?? null,
        },
        kind === 'flow' ? group.filter((f) => f.start !== null) : group,
      )
      series.dims = [...new Set(group.map((f) => f.dims))].join(' | ')
      if (series.points.length) labSeries.push(series)
    }
    labSeries.sort((a, b) => (a.points[0]!.end < b.points[0]!.end ? -1 : 1))
    out.push(...labSeries)
  }
  return out
}

/** True for a series a new filing's point should raise an alert on. */
export function isAlerting(series: ExposureSeries): boolean {
  if (series.group === 'openai' || series.group === 'anthropic') {
    return (ALERTING_LAB_CONCEPTS as readonly string[]).includes(series.concept)
  }
  return SERIES_DEFS.find((d) => d.id === series.id)?.alert === true
}

/** Figures an analyst would look for that these filings don't tag. Checked 2026-11-04. */
export const EXPOSURE_GAPS: readonly ExposureGap[] = [
  {
    id: 'googl-anthropic',
    group: 'anthropic',
    ticker: 'GOOGL',
    title: 'Alphabet’s Anthropic stake isn’t in its filings',
    reason:
      'EDGAR full-text search finds no Alphabet 10-Q or 10-K that mentions Anthropic (checked 2026-11-04), and no XBRL fact names it. The 10-Q for the quarter to 2026-09-30 describes “our investment in one private company” without naming it. We don’t attach that to Anthropic.',
  },
  {
    id: 'meta-rpo',
    group: 'rpo',
    ticker: 'META',
    title: 'Meta tags no backlog',
    reason: 'Meta’s filings carry no remaining performance obligations fact.',
  },
]
