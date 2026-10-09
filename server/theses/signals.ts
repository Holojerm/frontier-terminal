// Measured signals: each turns data already in the store into dated readings
// for one claim. No signal fetches anything — the pipeline did that — so a
// reading's provenance is the stored rows it was computed from.
//
// Two of the three recompute their whole history from the store on every
// run (rankings rows and the job change log are kept forever). The spend
// premium cannot: it joins today's list prices, so it only ever reads the
// newest window, and its older readings are the ones earlier runs wrote.

import { companyName, type CompanyId } from '#shared/utils/companies'
import type { BigFour } from '#shared/utils/terminal-types'
import type { ClaimDef, SignalSpec } from '#shared/utils/thesis-types'

import type { PipelineDb } from '../pipeline/store'
import { queryContext, queryHiringHistory } from '../utils/terminal-db'
import { rankingObservations, type RankingObservation } from '../utils/terminal-rankings'
import { splitPermaslug, catalogRows, summarizeSpend } from '../utils/terminal-spend'
import { PROVIDER_ORDER } from '../utils/terminal-sources'
import type { Formatter } from './status'

export interface SignalReading {
  date: string
  value: number
  detail: Record<string, unknown> & { compare: number | null }
  source_url: string
  fetched_at: string
}

export interface SignalDeps {
  sourcesYaml: string
  now: () => Date
}

type Measured = Extract<SignalSpec, { kind: 'measured' }>

const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places

const newestProv = (rows: readonly RankingObservation[]) =>
  rows.reduce((a, b) => (b.fetched_at > a.fetched_at ? b : a))

/** Spend share ÷ token share per lab, newest 7-day window, today's list prices. */
async function spendPremium(
  db: PipelineDb,
  company: BigFour,
  comparator: BigFour | null,
): Promise<SignalReading[]> {
  const [rows, catalog] = await Promise.all([rankingObservations(db), catalogRows(db)])
  const summary = summarizeSpend(rows, catalog)
  if (!summary.window) return []
  const ratios: Partial<Record<BigFour, number>> = {}
  for (const p of summary.providers) {
    if (p.share_low === null || p.share_high === null || !p.token_share) continue
    ratios[p.provider] = round((p.share_low + p.share_high) / 2 / p.token_share)
  }
  const value = ratios[company]
  if (value === undefined) return []
  const { from, to } = summary.window
  const prov = newestProv(rows.filter((r) => r.date >= from && r.date <= to))
  const own = summary.providers.find((p) => p.provider === company)!
  return [
    {
      date: to,
      value,
      detail: {
        window: summary.window,
        ratios,
        spend_share_low: own.share_low,
        spend_share_high: own.share_high,
        token_share: own.token_share,
        coverage: own.coverage,
        compare: comparator ? (ratios[comparator] ?? null) : null,
      },
      source_url: prov.source_url,
      fetched_at: prov.fetched_at,
    },
  ]
}

/** The company's share of the four labs' tokens over each trailing 7 days present. */
async function labTokenShare(
  db: PipelineDb,
  company: BigFour,
  days: number,
): Promise<SignalReading[]> {
  const rows = (await rankingObservations(db, days)).filter((r) =>
    splitPermaslug(r.model_permaslug),
  )
  const dates = [...new Set(rows.map((r) => r.date))].sort()
  const out: SignalReading[] = []
  for (let i = 6; i < dates.length; i++) {
    const window = new Set(dates.slice(i - 6, i + 1))
    const inWindow = rows.filter((r) => window.has(r.date))
    const tokens = Object.fromEntries(PROVIDER_ORDER.map((p) => [p, 0])) as Record<BigFour, number>
    for (const r of inWindow) tokens[r.provider as BigFour] += r.total_tokens
    const lab = PROVIDER_ORDER.reduce((n, p) => n + tokens[p], 0)
    if (lab === 0) continue
    const shares = Object.fromEntries(PROVIDER_ORDER.map((p) => [p, round(tokens[p] / lab)]))
    const prov = newestProv(inWindow)
    out.push({
      date: dates[i]!,
      value: round(tokens[company] / lab),
      detail: { window: { from: dates[i - 6], to: dates[i] }, shares, compare: null },
      source_url: prov.source_url,
      fetched_at: prov.fetched_at,
    })
  }
  return out
}

/** Open roles in the named departments at the end of each day, from the job change log. */
async function openRolesIn(
  db: PipelineDb,
  company: BigFour,
  departments: readonly string[],
  deps: SignalDeps,
): Promise<SignalReading[]> {
  const history = await queryHiringHistory(db, queryContext(deps.sourcesYaml, null, deps.now))
  const board = history.providers.find((p) => p.provider === company)
  const source = board?.sources[0]
  if (!board || board.feed === 'no_public_feed' || !source) return []
  const series = board.departments.filter((d) => departments.includes(d.department))
  return board.dates.map((date, i) => {
    const by = Object.fromEntries(series.map((d) => [d.department, d.series[i] ?? 0]))
    return {
      date,
      value: Object.values(by).reduce((n, v) => n + v, 0),
      detail: { by_department: by, compare: null },
      source_url: source.source_url,
      fetched_at: source.fetched_at,
    }
  })
}

const isLab = (id: CompanyId): id is BigFour => (PROVIDER_ORDER as readonly string[]).includes(id)

/** Readings for one measured claim of a thesis about `company`. */
export async function readSignal(
  db: PipelineDb,
  company: CompanyId,
  claim: ClaimDef,
  deps: SignalDeps,
  historyDays: number,
): Promise<SignalReading[]> {
  const spec = claim.spec as Measured
  switch (spec.signal) {
    // The OpenRouter and job-board signals read lab rows only.
    case 'openrouter-spend-premium':
      if (!isLab(company)) return []
      return spendPremium(
        db,
        company,
        spec.rule.rule === 'sustained-floor' ? spec.rule.comparator : null,
      )
    case 'openrouter-lab-token-share':
      if (!isLab(company)) return []
      return labTokenShare(db, company, historyDays)
    case 'open-roles-in-departments':
      if (!isLab(company)) return []
      return openRolesIn(db, company, spec.departments, deps)
  }
}

/** Only the newest reading of a signal that cannot be recomputed is written. */
export const recomputable = (spec: Measured) => spec.signal !== 'openrouter-spend-premium'

const FORMATS: Record<Measured['signal'], Formatter> = {
  'openrouter-spend-premium': (v) => `${v.toFixed(2)}×`,
  'openrouter-lab-token-share': (v) => `${(v * 100).toFixed(1)}%`,
  'open-roles-in-departments': (v) => `${Math.round(v)} open roles`,
}

/** How a claim's values read in a status reason, and whose value it is compared with. */
export function presentation(claim: ClaimDef): { fmt: Formatter; comparatorName: string | null } {
  const spec = claim.spec
  if (spec.kind === 'judged') return { fmt: String, comparatorName: null }
  const comparator = spec.rule.rule === 'sustained-floor' ? spec.rule.comparator : null
  return {
    fmt: FORMATS[spec.signal],
    comparatorName: comparator ? companyName(comparator) : null,
  }
}
