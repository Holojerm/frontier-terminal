// Disclosed-revenue growth, read from the periods the revenue axis shows
// (terminal-revenue.ts): the newest filing's value per period, restatements
// applied, so a claim reads the same figures the /revenue page prints.

import type { LabId, RevenuePeriod } from '../../shared/utils/terminal-types'

import type { PipelineDb } from '../pipeline/store'
import { queryContext } from '../utils/terminal-db'
import { queryRevenue } from '../utils/terminal-revenue'
import type { SignalDeps, SignalReading } from './signals'

const DAY_MS = 86_400_000
const dayOf = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS
const round = (n: number) => Math.round(n * 10_000) / 10_000

type Period = Pick<
  RevenuePeriod,
  | 'start'
  | 'end'
  | 'days'
  | 'val'
  | 'form'
  | 'filed'
  | 'filing_url'
  | 'unaudited'
  | 'source_url'
  | 'fetched_at'
>

/**
 * Each period against the period of the same length ending a year earlier.
 * A filing can report several spans to one date (a quarter and the
 * year-to-date); readings are one per date, so the longest span with a base
 * is the one read.
 */
export function revenueGrowth(periods: readonly Period[]): SignalReading[] {
  const byEnd = new Map<string, SignalReading & { days: number }>()
  for (const p of periods) {
    const base = periods.find(
      (b) => Math.abs(b.days - p.days) <= 7 && Math.abs(dayOf(b.end) - (dayOf(p.end) - 365)) <= 21,
    )
    if (!base || base.val <= 0) continue
    const held = byEnd.get(p.end)
    if (held && held.days >= p.days) continue
    byEnd.set(p.end, {
      days: p.days,
      date: p.end,
      value: round(p.val / base.val - 1),
      detail: {
        start: p.start,
        value: p.val,
        unaudited: p.unaudited,
        form: p.form,
        filed: p.filed,
        filing_url: p.filing_url,
        base_start: base.start,
        base_date: base.end,
        base_value: base.val,
        compare: null,
      },
      source_url: p.source_url,
      fetched_at: p.fetched_at,
    })
  }
  return [...byEnd.values()]
    .map(({ days: _days, ...r }) => r)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

export async function secRevenueGrowth(
  db: PipelineDb,
  company: LabId,
  deps: SignalDeps,
): Promise<SignalReading[]> {
  const revenue = await queryRevenue(db, queryContext(deps.sourcesYaml, null, deps.now))
  const own = revenue.providers.find((p) => p.provider === company)
  // A parent's figure (a segment, or the whole parent) is not the lab's revenue.
  if (!own || own.filer?.relation !== 'issuer') return []
  return revenueGrowth(own.periods)
}
