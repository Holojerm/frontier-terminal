// Forward calls: a figure estimated before it is filed, by every method we
// ran, each scored once the filing prints the actual. Calls registered in
// code (forward-calls-registered.ts) are pinned by forward-calls.lock.json;
// the rules in forward-rules.ts record more on the daily signals run. Either
// way a call is inserted once and never edited, and its scores are inserted
// once, the first time a filing after the call settles its period.

import * as tables from '#server/db/schema'
import {
  flowSum,
  instantOf,
  revenueOf,
  type ConceptFact,
  type Filed,
} from '../../../companies/server/calls/actuals'
import { conceptFacts } from '../../../companies/server/calls/ingest'
import { filingUrl } from '../../../companies/server/exposure/series'
import { REGISTERED_CALLS } from './forward-calls-registered'
import { conceptsOf, forwardFiler } from './forward-filers'

export const FORWARD_CALLS = REGISTERED_CALLS

export const KIND_FORWARD_CALLS_FAILED = 'forward_calls_failed'

/** The call as its forward_calls row, written at `at`. */
function callRow(
  c: ForwardCall,
  appUrl: string,
  at: string,
): typeof tables.forwardCalls.$inferInsert {
  return {
    id: c.id,
    rule: c.rule,
    kind: c.kind,
    ticker: c.ticker,
    metric: c.metric,
    fiscal_year: c.fiscal_year,
    fiscal_quarter: c.fiscal_quarter,
    period_start: c.period.start,
    period_end: c.period.end,
    label: c.label,
    resolves_from: c.resolves_from,
    methods: JSON.stringify(c.methods),
    inputs: JSON.stringify(c.inputs),
    note: c.note,
    recorded_at: c.recorded,
    source_url: `${appUrl}/signals#call-${c.id}`,
    fetched_at: c.recorded.length > 10 ? c.recorded : at,
  }
}

function callOf(row: typeof tables.forwardCalls.$inferSelect): ForwardCall {
  return {
    id: row.id,
    rule: row.rule as ForwardCall['rule'],
    kind: row.kind as ForwardCall['kind'],
    ticker: row.ticker,
    metric: row.metric as ForwardCall['metric'],
    fiscal_year: row.fiscal_year,
    fiscal_quarter: row.fiscal_quarter,
    period: { start: row.period_start, end: row.period_end },
    label: row.label,
    resolves_from: row.resolves_from,
    methods: JSON.parse(row.methods) as ForwardMethod[],
    inputs: JSON.parse(row.inputs) as ForwardInput[],
    note: row.note,
    recorded: row.recorded_at,
  }
}

/** Inserts the calls not held yet and returns how many were new. A held id keeps its first row. */
export async function recordCalls(
  db: PipelineDb,
  calls: readonly ForwardCall[],
  appUrl: string,
  now: Date,
): Promise<number> {
  if (!calls.length) return 0
  const held = new Set(
    (await db.select({ id: tables.forwardCalls.id }).from(tables.forwardCalls)).map((r) => r.id),
  )
  const fresh = calls
    .filter((c) => !held.has(c.id))
    .map((c) => callRow(c, appUrl, now.toISOString()))
  await runStatements(
    db,
    chunk(fresh, rowsPerStatement(17)).map((part) =>
      db.insert(tables.forwardCalls).values(part).onConflictDoNothing(),
    ),
  )
  return fresh.length
}

/** Every call: the rows held, and any registered call the daily run hasn't copied in yet. */
export async function allCalls(db: PipelineDb): Promise<ForwardCall[]> {
  const rows = (await db.select().from(tables.forwardCalls)).map(callOf)
  const ids = new Set(rows.map((r) => r.id))
  return [...FORWARD_CALLS.filter((c) => !ids.has(c.id)), ...rows]
}

/** The call's range: the lowest to the highest non-control estimate. */
export function callRange(c: Pick<ForwardCall, 'methods'>): [number, number] {
  const real = c.methods.filter((m) => !m.control)
  const used = real.length ? real : c.methods
  return [
    Math.min(...used.map((m) => m.low ?? m.value)),
    Math.max(...used.map((m) => m.high ?? m.value)),
  ]
}

const inside = (v: number, low: number, high: number) => v >= low && v <= high

/** The filed figure for a listed company's call, or null until it is filed. */
export function settle(
  call: Pick<ForwardCall, 'metric' | 'resolves_from' | 'fiscal_year' | 'fiscal_quarter' | 'period'>,
  facts: readonly ConceptFact[],
  fyEndMonth: number,
): Filed | null {
  const p = {
    fiscal_year: call.fiscal_year,
    quarter: call.fiscal_quarter,
    start: call.period.start,
    end: call.period.end,
  }
  const concepts = conceptsOf(call)
  if (call.metric === 'revenue') return revenueOf(facts, fyEndMonth, p)
  if (call.metric === 'backlog') return concepts[0] ? instantOf(facts, concepts[0], p.end) : null
  return flowSum(facts, concepts, fyEndMonth, p)
}

export interface Settled {
  value: number
  concept: string
  form: string
  filed: string
  accession_no: string
  source_url: string
  fetched_at: string
}

/** One score row per method for a settled call. */
function scoreRows(
  call: ForwardCall,
  actual: Settled,
  now: Date,
): (typeof tables.forwardCallScores.$inferInsert)[] {
  const [low, high] = callRange(call)
  const inCall = inside(actual.value, low, high) ? 1 : 0
  return call.methods.map((m) => ({
    id: contentHash({ call: call.id, method: m.method, accession: actual.accession_no }),
    call_id: call.id,
    method: m.method,
    control: m.control ? 1 : 0,
    estimate: m.value,
    low: m.low,
    high: m.high,
    actual: actual.value,
    error_pct: ((m.value - actual.value) / actual.value) * 100,
    in_method_range:
      m.low !== null && m.high !== null ? (inside(actual.value, m.low, m.high) ? 1 : 0) : null,
    in_call_range: inCall,
    concept: actual.concept,
    form: actual.form,
    filed: actual.filed,
    accession_no: actual.accession_no,
    first_seen_at: now.toISOString(),
    source_url: actual.source_url,
    fetched_at: actual.fetched_at,
  }))
}

/** A lab's figure for the call's period from its S-1, 10-Q or 10-K. */
function labActual(call: ForwardCall, revenue: Pick<RevenueData, 'providers'>): Settled | null {
  const lab = call.resolves_from.slice('lab-revenue:'.length)
  const provider = revenue.providers.find((p) => p.provider === lab)
  if (!provider) return null
  const f = filedFigures([...provider.periods, ...provider.superseded]).find(
    (x) => x.start === call.period.start && x.end === call.period.end,
  )
  if (!f) return null
  return {
    value: f.val,
    concept: 'revenue',
    form: f.form,
    filed: f.first_filed,
    accession_no: f.accession_no,
    source_url: f.filing_url,
    fetched_at: f.fetched_at,
  }
}

/** Scores each unscored call whose period a filing made after the call now settles. */
export async function resolveForwardCalls(
  db: PipelineDb,
  revenue: Pick<RevenueData, 'providers'>,
  now: Date,
): Promise<number> {
  const today = now.toISOString().slice(0, 10)
  const [calls, scored] = await Promise.all([
    allCalls(db),
    db.selectDistinct({ id: tables.forwardCallScores.call_id }).from(tables.forwardCallScores),
  ])
  const done = new Set(scored.map((s) => s.id))
  const facts = new Map<string, ConceptFact[]>()
  const rows: (typeof tables.forwardCallScores.$inferInsert)[] = []
  let settled = 0
  for (const call of calls) {
    if (done.has(call.id) || call.period.end >= today) continue
    let actual: Settled | null = null
    if (call.resolves_from.startsWith('lab-revenue:')) {
      actual = labActual(call, revenue)
    } else {
      const filer = forwardFiler(call.ticker)
      if (!filer) continue
      if (!facts.has(call.ticker)) facts.set(call.ticker, await conceptFacts(db, call.ticker))
      const f = settle(call, facts.get(call.ticker)!, filer.fy_end_month)
      if (f) actual = { ...f, source_url: filingUrl(filer.cik, f.accession_no) }
    }
    // A figure filed on or before the day of the call isn't a forecast of it.
    if (!actual || actual.filed <= call.recorded.slice(0, 10)) continue
    rows.push(...scoreRows(call, actual, now))
    settled++
  }
  await runStatements(
    db,
    chunk(rows, rowsPerStatement(18)).map((part) =>
      db.insert(tables.forwardCallScores).values(part).onConflictDoNothing(),
    ),
  )
  return settled
}

/** Every call with its scores, open calls first by period end, then settled ones newest filing first. */
export async function forwardCallViews(db: PipelineDb): Promise<ForwardCallView[]> {
  const [calls, scores] = await Promise.all([
    allCalls(db),
    db.select().from(tables.forwardCallScores),
  ])
  const byCall = new Map<string, (typeof scores)[number][]>()
  for (const s of scores) byCall.set(s.call_id, [...(byCall.get(s.call_id) ?? []), s])
  const views: ForwardCallView[] = calls.map((call) => {
    const mine = byCall.get(call.id) ?? []
    // The first filing to settle it, if a restatement ever adds a second.
    const first = mine.reduce<(typeof mine)[number] | null>(
      (a, b) => (!a || b.filed < a.filed ? b : a),
      null,
    )
    const own = first ? mine.filter((s) => s.accession_no === first.accession_no) : []
    return {
      ...call,
      unit: 'USD',
      methods: call.methods.map((m) => {
        const s = own.find((x) => x.method === m.method)
        return {
          ...m,
          error_pct: s?.error_pct ?? null,
          in_range: s && s.in_method_range !== null ? s.in_method_range === 1 : null,
        }
      }),
      actual: first
        ? {
            value: first.actual,
            filed: first.filed,
            form: first.form,
            filing_url: first.source_url,
            in_range: first.in_call_range === 1,
          }
        : null,
    }
  })
  return views.sort((a, b) => {
    if (!a.actual !== !b.actual) return a.actual ? 1 : -1
    if (a.actual && b.actual) return b.actual.filed.localeCompare(a.actual.filed)
    return (
      a.period.end.localeCompare(b.period.end) ||
      a.ticker.localeCompare(b.ticker) ||
      a.recorded.localeCompare(b.recorded)
    )
  })
}
