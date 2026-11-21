// The filers forward calls are settled against, and the XBRL concepts the
// hourly call reader (calls/ingest.ts) has to read for them. Kept apart from
// forward-calls.ts, which imports the reader, so the reader can import this.

import { sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { REVENUE_CONCEPTS } from '../../../companies/server/calls/actuals'
import { CALL_COMPANIES } from '../../../companies/server/calls/curated'
import { REGISTERED_CALLS } from './forward-calls-registered'

export interface ForwardFiler {
  company: string
  cik: string
  /** The calendar month the fiscal year ends in. */
  fy_end_month: number
}

/** Filers a forward call names that the call reader doesn't cover. */
export const FORWARD_FILERS: Readonly<Record<string, ForwardFiler>> = {
  MU: { company: 'Micron', cik: '0000723125', fy_end_month: 8 },
}

export function forwardFiler(ticker: string): ForwardFiler | null {
  const c = CALL_COMPANIES.get(ticker)
  return c
    ? { company: c.company, cik: c.cik, fy_end_month: c.fy_end_month }
    : (FORWARD_FILERS[ticker] ?? null)
}

/**
 * A company's quarterly revenue estimated from a monthly print series: the
 * quarter's months summed, against how revenue has tracked the same sum.
 * Korea's chip exports print for the first 10 and 20 days of a month before
 * the whole month, so Micron gets a call at each.
 */
export interface PrintRule {
  ticker: string
  entity: string
  series: 'kr_chip_exports' | 'tw_revenue'
  /** How the series reads in a method's name. */
  name: string
  windows: readonly ('d10' | 'd20' | 'month')[]
}

export const PRINT_RULES: readonly PrintRule[] = [
  {
    ticker: 'MU',
    entity: 'kr-semiconductors',
    series: 'kr_chip_exports',
    name: 'Korea’s chip exports',
    windows: ['d10', 'd20', 'month'],
  },
  {
    ticker: 'NVDA',
    entity: 'tsmc',
    series: 'tw_revenue',
    name: 'TSMC revenue',
    windows: ['month'],
  },
]

/** The concepts a call is settled from, in the order they are tried (revenue, backlog) or summed (capex). */
export const conceptsOf = (call: Pick<ForwardCall, 'resolves_from'>): string[] =>
  call.resolves_from.startsWith('lab-revenue:') ? [] : call.resolves_from.split(',')

/** The concepts a rule-recorded call of this metric reads, for a ticker. */
export function ruleConcepts(ticker: string, metric: ForwardMetric): string {
  if (metric === 'revenue') return REVENUE_CONCEPTS.join(',')
  if (metric === 'backlog') return 'us-gaap:RevenueRemainingPerformanceObligation'
  return ticker === 'META'
    ? 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment,us-gaap:FinanceLeasePrincipalPayments'
    : 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment'
}

/**
 * What the call reader should read for forward calls: the concepts of each
 * unsettled call whose period has ended, and each prints rule's revenue, which
 * its history needs every quarter.
 */
export async function forwardConceptNeeds(
  db: PipelineDb,
  today: string,
): Promise<{ ticker: string; concept: string }[]> {
  const [recorded, scored] = await Promise.all([
    db
      .select({
        ticker: tables.forwardCalls.ticker,
        resolves_from: tables.forwardCalls.resolves_from,
        period_end: tables.forwardCalls.period_end,
        id: tables.forwardCalls.id,
      })
      .from(tables.forwardCalls)
      .where(sql`${tables.forwardCalls.period_end} < ${today}`),
    db.selectDistinct({ id: tables.forwardCallScores.call_id }).from(tables.forwardCallScores),
  ])
  const done = new Set(scored.map((s) => s.id))
  const out = new Map<string, { ticker: string; concept: string }>()
  const add = (ticker: string, concept: string) => {
    if (forwardFiler(ticker)) out.set(`${ticker}|${concept}`, { ticker, concept })
  }
  for (const c of [...REGISTERED_CALLS, ...recorded]) {
    const end = 'period' in c ? c.period.end : c.period_end
    if (done.has(c.id) || end >= today) continue
    for (const concept of conceptsOf(c)) add(c.ticker, concept)
  }
  for (const r of PRINT_RULES) for (const concept of REVENUE_CONCEPTS) add(r.ticker, concept)
  return [...out.values()]
}
