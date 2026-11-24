// A filer's total line (capex, backlog) as the harness reads it: each quarter
// as first filed, since a later filing's comparative is a restatement nobody
// had, then its log growth on a year or a quarter before. Several filers sum
// like for like: a quarter's growth counts only the filers stated in both
// quarters, so a filer whose facts start later (Amazon and Microsoft from
// 2019) joins without breaking the series.

import { RPO_START, quarterly, type StoredFact } from '#layers/companies/server/exposure/series'
import type { Point } from './harness'

export interface FiledGrowthFiler {
  ticker: string
  concept: string
}

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/**
 * The filer's whole amount. A backlog tagged on the timing axis from the day
 * after the period end is all of it (Amazon since 2020); any other dimension
 * is a part.
 */
export const isTotal = (dims: string, end: string) =>
  dims === '' || dims === `${RPO_START}=${nextDay(end)}`

/** One value per quarter, keyed by the month the quarter ends in. */
interface Quarter {
  value: number
  filed: string
}

/** The first filing of each period, of the total amount only. */
function firstFiled(facts: readonly StoredFact[]): Map<string, StoredFact> {
  const first = new Map<string, StoredFact>()
  for (const f of facts) {
    if (!isTotal(f.dims, f.end)) continue
    const key = `${f.start ?? ''}|${f.end}`
    const had = first.get(key)
    if (!had || f.filed < had.filed) first.set(key, f)
  }
  return first
}

/** A flow's 3-month quarters, derived from year-to-date pairs where untagged; a balance at each end. */
export function filerQuarters(
  facts: readonly StoredFact[],
  measure: 'flow' | 'balance',
): Map<string, Quarter> {
  const byPeriod = firstFiled(facts)
  const out = new Map<string, Quarter>()
  if (measure === 'flow') {
    for (const p of quarterly(byPeriod)) {
      if (p.months !== 3) continue
      // A derived quarter is public once both filings it reads are.
      const filed = p.less && p.less.filed > p.filed ? p.less.filed : p.filed
      out.set(p.end.slice(0, 7), { value: p.value, filed })
    }
  } else {
    for (const f of byPeriod.values()) {
      if (f.start === null) out.set(f.end.slice(0, 7), { value: f.value, filed: f.filed })
    }
  }
  return out
}

const monthsBefore = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const i = y * 12 + (m - 1) - n
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`
}

/**
 * Log growth of the filers' summed quarter on the same filers a year (12
 * months) or a quarter (3) before, public when the last of them had filed.
 */
export function filedGrowth(filers: readonly Map<string, Quarter>[], lagMonths: 3 | 12): Point[] {
  const months = new Set(filers.flatMap((f) => [...f.keys()]))
  const out: Point[] = []
  for (const month of [...months].sort()) {
    const before = monthsBefore(month, lagMonths)
    const both = filers.flatMap((f) => {
      const cur = f.get(month)
      const prev = f.get(before)
      return cur && prev ? [{ cur, prev }] : []
    })
    if (!both.length) continue
    const cur = both.reduce((s, b) => s + b.cur.value, 0)
    const prev = both.reduce((s, b) => s + b.prev.value, 0)
    if (!(cur > 0 && prev > 0)) continue
    const filed = both.reduce((a, b) => (b.cur.filed > a ? b.cur.filed : a), '')
    out.push({ date: `${month}-01`, value: Math.log(cur / prev), available: filed })
  }
  return out
}

/** The filers a source names, as their stored facts. */
export function factsOf(
  rows: readonly StoredFact[],
  filers: readonly FiledGrowthFiler[],
): StoredFact[][] {
  return filers.map((f) => rows.filter((r) => r.ticker === f.ticker && r.concept === f.concept))
}
