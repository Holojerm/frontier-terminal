// The forward calls that record themselves on the daily signals run, so a
// call exists for each quarter without anyone writing it:
//
//   guidance-bias  each revenue, capex or backlog figure a company guided for
//                  a period still running, first read on or after RULES_FROM:
//                  the guided midpoint, and the midpoint moved by the median
//                  error of the company's own settled guidance and of every
//                  company's. A year's guide with three quarters filed becomes
//                  a call on the fourth: the year less the three.
//   prints-ratio   a quarter's revenue from a monthly print series (PRINT_RULES)
//                  once its first two months and the third's 10-day, 20-day
//                  or whole print are in, and no later than PRINT_WINDOW_DAYS
//                  after it ends, so it lands before the earnings release.
//
// Every method that has its inputs runs, and all are recorded. A call's id
// names its target and inputs, so a rule never records the same call twice.

import { and, eq, gt, gte, inArray, lt } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { unscorable, type ConceptFact } from '../../../companies/server/calls/actuals'
import { CALL_SOURCES, conceptFacts } from '../../../companies/server/calls/ingest'
import {
  daysBetween,
  fiscalPeriod,
  periodLabel,
  type FiscalPeriod,
} from '../../../companies/server/calls/periods'
import { filingUrl } from '../../../companies/server/exposure/series'
import { FORWARD_CALLS, recordCalls, resolveForwardCalls, settle } from './forward-calls'
import { forwardFiler, PRINT_RULES, ruleConcepts, type PrintRule } from './forward-filers'

/** Guidance first read before this was registered by hand (forward-calls-registered.ts). */
const RULES_FROM = '2026-11-22'
/** A bias needs this many settled statements: the company's own, then every company's. */
const OWN_BIAS_MIN = 2
const POOLED_BIAS_MIN = 5
/** A guided figure this far from the last comparable filed one is a misread, not a forecast. */
const PLAUSIBLE = [0.4, 3] as const
/** A prints call is recorded at most this many days after its quarter ends. */
const PRINT_WINDOW_DAYS = 14
/** History pairs for the median ratio. */
const RATIO_QUARTERS = 4

const METRICS: readonly ForwardMetric[] = ['revenue', 'capex', 'backlog']
const WORD: Record<ForwardMetric, string> = {
  revenue: 'revenue',
  capex: 'capex',
  backlog: 'remaining performance obligations',
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

const method = (
  name: string,
  value: number,
  low: number | null = null,
  high: number | null = null,
): ForwardMethod => ({ method: name, value, low, high, control: false })

const prevQuarter = (fy: number, p: FiscalPeriod): FiscalPeriod =>
  p.quarter === 1
    ? fiscalPeriod(fy, p.fiscal_year - 1, 4)
    : fiscalPeriod(fy, p.fiscal_year, p.quarter! - 1)

type Target = Pick<
  ForwardCall,
  'metric' | 'resolves_from' | 'fiscal_year' | 'fiscal_quarter' | 'period'
>

const target = (ticker: string, metric: ForwardMetric, p: FiscalPeriod): Target => ({
  metric,
  resolves_from: ruleConcepts(ticker, metric),
  fiscal_year: p.fiscal_year,
  fiscal_quarter: p.quarter,
  period: { start: p.start, end: p.end },
})

/** The median guidance error per (ticker, metric), and per metric across companies. */
async function guidanceBias(db: PipelineDb, today: string) {
  const rows = await db
    .select({
      ticker: tables.guidanceResolutions.ticker,
      metric: tables.guidanceResolutions.metric,
      error_share: tables.guidanceResolutions.error_share,
      fiscal_year: tables.filedGuidance.fiscal_year,
      fiscal_quarter: tables.filedGuidance.fiscal_quarter,
      called: tables.filedGuidance.filed,
    })
    .from(tables.guidanceResolutions)
    .innerJoin(
      tables.filedGuidance,
      eq(tables.filedGuidance.id, tables.guidanceResolutions.guidance_id),
    )
    .where(and(eq(tables.filedGuidance.unit, 'USD'), lt(tables.guidanceResolutions.filed, today)))
  // The same figure stated twice on one call (a range and its midpoint) counts once.
  const seen = new Set<string>()
  const own = new Map<string, number[]>()
  const pooled = new Map<string, number[]>()
  for (const r of rows) {
    const key = [r.ticker, r.metric, r.fiscal_year, r.fiscal_quarter, r.called].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    own.set(`${r.ticker}|${r.metric}`, [
      ...(own.get(`${r.ticker}|${r.metric}`) ?? []),
      r.error_share,
    ])
    pooled.set(r.metric, [...(pooled.get(r.metric) ?? []), r.error_share])
  }
  return {
    own: (ticker: string, metric: string) => own.get(`${ticker}|${metric}`) ?? [],
    pooled: (metric: string) => pooled.get(metric) ?? [],
  }
}

/** Calls from guidance first read on or after RULES_FROM, for periods still running. */
export async function guidanceBiasCalls(db: PipelineDb, now: Date): Promise<ForwardCall[]> {
  const today = now.toISOString().slice(0, 10)
  const statements = await db
    .select()
    .from(tables.filedGuidance)
    .where(
      and(
        inArray(tables.filedGuidance.source, [...CALL_SOURCES]),
        inArray(tables.filedGuidance.metric, [...METRICS]),
        eq(tables.filedGuidance.unit, 'USD'),
        inArray(tables.filedGuidance.bound, ['range', 'about']),
        gte(tables.filedGuidance.first_seen_at, RULES_FROM),
        gt(tables.filedGuidance.period_end, today),
      ),
    )
  if (!statements.length) return []
  // One statement per figure and call; a range over a single figure.
  const pick = new Map<string, (typeof statements)[number]>()
  for (const g of statements) {
    const key = [g.ticker, g.metric, g.fiscal_year, g.fiscal_quarter, g.filed].join('|')
    const held = pick.get(key)
    if (!held || (held.bound !== 'range' && g.bound === 'range')) pick.set(key, g)
  }
  const bias = await guidanceBias(db, today)
  const facts = new Map<string, ConceptFact[]>()
  const out: ForwardCall[] = []
  for (const g of pick.values()) {
    const metric = g.metric as ForwardMetric
    const filer = forwardFiler(g.ticker)
    if (!filer || !g.period_start || !g.period_end || unscorable(g.ticker, g)) continue
    const fy = filer.fy_end_month
    if (!facts.has(g.ticker)) facts.set(g.ticker, await conceptFacts(db, g.ticker))
    const held = facts.get(g.ticker)!
    const guided: FiscalPeriod = {
      ...fiscalPeriod(fy, g.fiscal_year, g.fiscal_quarter),
      start: g.period_start,
      end: g.period_end,
    }
    // A year with three quarters filed: the call is on the fourth.
    let p = guided
    let less = 0
    const inputs: ForwardInput[] = []
    if (guided.quarter === null && metric !== 'backlog') {
      const filed = [1, 2, 3].map((q) =>
        settle(target(g.ticker, metric, fiscalPeriod(fy, g.fiscal_year, q)), held, fy),
      )
      if (filed.every(Boolean)) {
        p = { ...fiscalPeriod(fy, g.fiscal_year, 4), end: g.period_end }
        for (const [i, f] of filed.entries()) {
          less += f!.value
          inputs.push({
            label: `${WORD[metric]}, Q${i + 1} filed`,
            value: f!.value,
            unit: 'USD',
            as_of: f!.filed,
            source_url: filingUrl(filer.cik, f!.accession_no),
          })
        }
      }
    }
    const mid = (g.low + g.high) / 2
    if (mid - less <= 0) continue
    // The figure before, to catch a misread: the quarter before, or the year before.
    const before =
      p.quarter === null
        ? settle(target(g.ticker, metric, fiscalPeriod(fy, p.fiscal_year - 1, null)), held, fy)
        : settle(target(g.ticker, metric, prevQuarter(fy, p)), held, fy)
    if (before && before.value > 0) {
      const ratio = (mid - less) / before.value
      if (ratio < PLAUSIBLE[0] || ratio > PLAUSIBLE[1]) continue
    }
    const range = g.bound === 'range'
    const span = less ? ' less the quarters filed' : ''
    const methods = [
      method(
        `Guidance from the ${g.filed} call${span}`,
        mid - less,
        range ? g.low - less : null,
        range ? g.high - less : null,
      ),
    ]
    const own = bias.own(g.ticker, metric)
    if (own.length >= OWN_BIAS_MIN) {
      const b = median(own)
      methods.push(
        method(
          `Guidance adjusted by ${g.ticker}’s median guidance error (${pct(b)}, n = ${own.length})`,
          mid * (1 + b) - less,
        ),
      )
    }
    const pooled = bias.pooled(metric)
    if (pooled.length >= POOLED_BIAS_MIN) {
      const b = median(pooled)
      methods.push(
        method(
          `Guidance adjusted by every company’s median ${WORD[metric]} guidance error (${pct(b)}, n = ${pooled.length})`,
          mid * (1 + b) - less,
        ),
      )
    }
    const url = g.page_url ?? g.source_url
    inputs.unshift(
      { label: 'Guidance, low', value: g.low, unit: 'USD', as_of: g.filed, source_url: url },
      { label: 'Guidance, high', value: g.high, unit: 'USD', as_of: g.filed, source_url: url },
      {
        label: `${g.ticker} median guidance error, ${own.length} settled`,
        value: own.length ? median(own) : null,
        unit: 'share',
        as_of: today,
        source_url: null,
      },
      {
        label: `Every company’s median guidance error, ${pooled.length} settled`,
        value: pooled.length ? median(pooled) : null,
        unit: 'share',
        as_of: today,
        source_url: null,
      },
    )
    out.push({
      id: `gb-${g.ticker}-${metric}-${p.end}-${g.filed}`.toLowerCase(),
      rule: 'guidance-bias',
      kind: 'forecast',
      ticker: g.ticker,
      ...target(g.ticker, metric, p),
      label: `${filer.company} ${WORD[metric]}, ${periodLabel(fy, p)}`,
      methods,
      inputs,
      note: less
        ? `The ${periodLabel(fy, guided)} guide less the three quarters filed.`
        : `Guided on the ${g.filed} call.`,
      recorded: now.toISOString(),
    })
  }
  return out
}

function monthsOf(p: FiscalPeriod): string[] {
  const [y, m] = p.start.split('-').map(Number) as [number, number]
  return [0, 1, 2].map((i) => {
    const t = y * 12 + (m - 1) + i
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
  })
}

/** The quarter that contains `day`, and the one before. */
function recentQuarters(fy: number, day: string): FiscalPeriod[] {
  const year = Number(day.slice(0, 4))
  for (const y of [year, year + 1]) {
    for (const q of [1, 2, 3, 4]) {
      const p = fiscalPeriod(fy, y, q)
      if (p.start <= day && day <= p.end) return [p, prevQuarter(fy, p)]
    }
  }
  return []
}

interface Print {
  value: number
  held: boolean
  first_seen_at: string
  source_url: string
}

/** A print series as it stands: the newest vintage of each month and window. */
async function printSeries(db: PipelineDb, rule: PrintRule) {
  const rows = await db
    .select()
    .from(tables.hardwarePrints)
    .where(
      and(
        eq(tables.hardwarePrints.series, rule.series),
        eq(tables.hardwarePrints.entity, rule.entity),
      ),
    )
  const best = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    const key = `${r.period}|${r.window}`
    const held = best.get(key)
    if (
      !held ||
      r.vintage > held.vintage ||
      (r.vintage === held.vintage && r.first_seen_at > held.first_seen_at)
    )
      best.set(key, r)
  }
  return (period: string, window: PrintWindow): Print | null => {
    const r = best.get(`${period}|${window}`)
    return r
      ? {
          value: r.value,
          held: PRINT_HELD_SOURCES.includes(r.source_id),
          first_seen_at: r.first_seen_at,
          source_url: r.source_url,
        }
      : null
  }
}

/** Calls from a print series for each quarter just ended whose months are in. */
export async function printRatioCalls(db: PipelineDb, now: Date): Promise<ForwardCall[]> {
  const today = now.toISOString().slice(0, 10)
  const out: ForwardCall[] = []
  for (const rule of PRINT_RULES) {
    const filer = forwardFiler(rule.ticker)
    if (!filer) continue
    const fy = filer.fy_end_month
    const [facts, print] = await Promise.all([conceptFacts(db, rule.ticker), printSeries(db, rule)])
    const revenue = (p: FiscalPeriod) => settle(target(rule.ticker, 'revenue', p), facts, fy)
    const quarterSum = (p: FiscalPeriod) => {
      const ms = monthsOf(p).map((m) => print(m, 'month'))
      return ms.every(Boolean) ? (ms as Print[]) : null
    }
    for (const q of recentQuarters(fy, today)) {
      // The 10- and 20-day prints of the last month arrive before the quarter
      // ends; the month's own print, after. Either way, never long after.
      if (daysBetween(q.end, today) > PRINT_WINDOW_DAYS || revenue(q)) continue
      const months = monthsOf(q)
      const last = months[2]!
      for (const w of rule.windows) {
        // Once the whole month is in, the month call covers it.
        if (w !== 'month' && print(last, 'month')) continue
        const parts = [print(months[0]!, 'month'), print(months[1]!, 'month'), print(last, w)]
        if (!parts.every(Boolean)) continue
        let scale = 1
        if (w !== 'month') {
          // How the whole month has run against its first 10 or 20 days.
          const ratios: number[] = []
          for (let back = 1; back <= 24; back++) {
            const [y, m] = last.split('-').map(Number) as [number, number]
            const t = y * 12 + (m - 1) - back
            const month = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
            const whole = print(month, 'month')
            const early = print(month, w)
            if (whole && early && early.value > 0) ratios.push(whole.value / early.value)
          }
          if (ratios.length < 6) continue
          scale = median(ratios)
        }
        const now3 = parts[0]!.value + parts[1]!.value + parts[2]!.value * scale
        // History: each earlier quarter with its revenue filed and its three months in.
        const history: {
          p: FiscalPeriod
          revenue: number
          prints: number
          url: string
          filed: string
        }[] = []
        let p = q
        for (let k = 1; k <= 8; k++) {
          p = prevQuarter(fy, p)
          const r = revenue(p)
          const s = quarterSum(p)
          if (r && s)
            history.push({
              p,
              revenue: r.value,
              prints: s.reduce((a, b) => a + b.value, 0),
              url: filingUrl(filer.cik, r.accession_no),
              filed: r.filed,
            })
          else if (k === 1 && r)
            history.push({
              p,
              revenue: r.value,
              prints: Number.NaN,
              url: filingUrl(filer.cik, r.accession_no),
              filed: r.filed,
            })
        }
        const paired = history.filter((h) => Number.isFinite(h.prints))
        const methods: ForwardMethod[] = []
        if (paired.length >= RATIO_QUARTERS) {
          const ratio = median(paired.slice(0, RATIO_QUARTERS).map((h) => h.revenue / h.prints))
          methods.push(
            method(
              `${rule.name} times the median ratio of the last ${RATIO_QUARTERS} quarters`,
              now3 * ratio,
            ),
          )
        }
        const prev = history.find((h) => h.p.end === prevQuarter(fy, q).end)
        if (prev && Number.isFinite(prev.prints)) {
          methods.push(
            method(`${rule.name} times last quarter’s ratio`, now3 * (prev.revenue / prev.prints)),
          )
          methods.push(
            method(
              `Last quarter grown as ${rule.name} grew on the quarter`,
              prev.revenue * (now3 / prev.prints),
            ),
          )
        }
        const yearAgo = history.find(
          (h) => h.p.fiscal_year === q.fiscal_year - 1 && h.p.quarter === q.quarter,
        )
        if (yearAgo && Number.isFinite(yearAgo.prints)) {
          methods.push(
            method(
              `A year earlier grown as ${rule.name} grew on the year`,
              yearAgo.revenue * (now3 / yearAgo.prints),
            ),
          )
        }
        if (!methods.length) continue
        if (prev) methods.push(method('Last quarter, held flat', prev.revenue))
        const window =
          w === 'month' ? '' : ` (${w === 'd10' ? 'first 10' : 'first 20'} days of ${last}, scaled)`
        const held = parts.some((x) => x!.held)
        const inputs: ForwardInput[] = [
          ...parts.map((x, i) => ({
            label: `${rule.name}, ${months[i]}${i === 2 && w !== 'month' ? ` first ${w.slice(1)} days` : ''}`,
            value: x!.held ? null : x!.value,
            unit: rule.series === 'kr_chip_exports' ? 'USD' : 'TWD',
            as_of: x!.first_seen_at,
            source_url: x!.source_url,
          })),
          ...history.map((h) => ({
            label: `Revenue, ${h.p.start} to ${h.p.end}`,
            value: h.revenue,
            unit: 'USD',
            as_of: h.filed,
            source_url: h.url,
          })),
        ]
        if (w !== 'month')
          inputs.push({
            label: `Whole month over its first ${w.slice(1)} days, median`,
            value: scale,
            unit: 'ratio',
            as_of: today,
            source_url: null,
          })
        out.push({
          id: `pr-${rule.ticker}-${rule.entity}-${w}-${q.end}`.toLowerCase(),
          rule: 'prints-ratio',
          kind: 'forecast',
          ticker: rule.ticker,
          ...target(rule.ticker, 'revenue', q),
          label: `${filer.company} revenue, ${periodLabel(fy, q)}`,
          methods,
          inputs,
          note: `From ${rule.name}, ${months[0]} to ${last}${window}.${held ? ' Figures held under the source’s terms show no value.' : ''}`,
          recorded: now.toISOString(),
        })
      }
    }
  }
  return out
}

/** Every rule's new calls. */
async function ruleCalls(db: PipelineDb, now: Date): Promise<ForwardCall[]> {
  return [...(await guidanceBiasCalls(db, now)), ...(await printRatioCalls(db, now))]
}

export interface ForwardRunReport {
  recorded: number
  settled: number
}

/** The daily step: copy the registered calls in, record each rule's new calls, then settle what has filed. */
export async function runForwardCalls(
  db: PipelineDb,
  deps: { revenue: Pick<RevenueData, 'providers'>; now: Date; appUrl: string },
): Promise<ForwardRunReport> {
  const recorded =
    (await recordCalls(db, FORWARD_CALLS, deps.appUrl, deps.now)) +
    (await recordCalls(db, await ruleCalls(db, deps.now), deps.appUrl, deps.now))
  const settled = await resolveForwardCalls(db, deps.revenue, deps.now)
  return { recorded, settled }
}
