// What a lab's own registration filings print beyond revenue: the whole
// statement of operations, commitments, customer concentration, share counts
// and risk-factor headings (layers/terminal/server/pipeline/parsers/sec/prospectus.ts).
//
// The statement follows the revenue axis's rule (terminal-revenue.ts): each
// period once, from the newest filing that reports it, the earlier filing's
// figures kept as superseded. A commitment schedule is shown per as-of date
// from the newest filing that states it; concentration, shares and the
// risk-factor headings from the newest filing; and each amendment's
// risk-factor headings are compared with the filing before it.

import { inArray } from 'drizzle-orm'
import type { z } from 'zod'

import type { LabId, SourceRef } from '../../shared/utils/terminal-types'
import type {
  CommitmentView,
  ConcentrationView,
  ProspectusData,
  ProspectusFilingRef,
  ProspectusIssuerView,
  RiskFactorDiffView,
  StatementLineView,
  StatementPeriodView,
  StatementView,
} from '../../shared/utils/terminal-prospectus'

import * as tables from '#server/db/schema'
import {
  CommitmentRow,
  ConcentrationRow,
  RiskFactorsRow,
  SharesRow,
  StatementRow,
} from '../pipeline/contracts'
import { riskFactorChanges } from '../pipeline/parsers/sec/prospectus-risk-factors'
import { OPTIONAL_LINES } from '../pipeline/parsers/sec/prospectus-statement'
import type { PipelineDb } from '../pipeline/store'
import { sourceStamps, type QueryContext } from './terminal-db'
import { byString } from './terminal-json'
import { filingIndexUrl, prospectusSourcePrefix } from './terminal-revenue'
import { PROVIDER_DISPLAY, PROVIDER_ORDER, labelOf } from './terminal-sources'

export const PROSPECTUS_RULE =
  'Read from the lab’s own registration statements (S-1 and its amendments) as printed: the statement of operations line by line, the contractual-commitment schedules, the 10%-customer tables, “The Offering” share counts and the risk-factor headings. ' +
  'Each period once, from the newest filing that reports it; a figure the filing leaves blank is not shown, and nothing is estimated. Interim periods are unaudited and marked.'

const DETAIL_TYPES = ['statement', 'commitment', 'concentration', 'shares', 'risk_factors'] as const

const OPTIONAL_LABELS: Readonly<Record<(typeof OPTIONAL_LINES)[number], string>> = {
  cost_of_revenue: 'Cost of revenue',
  gross_profit: 'Gross profit',
  research_and_development: 'Research and development',
  sales_and_marketing: 'Sales and marketing',
  general_and_administrative: 'General and administrative',
}

const SCHEDULE_ORDER: readonly CommitmentView['schedule'][] = [
  'obligations_aggregate',
  'contractual_obligations',
  'purchase_commitments_interim',
  'purchase_commitments',
]

const DAY_MS = 86_400_000
const daysBetween = (start: string, end: string) =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1

/** Newest filing first: by filing date, then accession. */
const newestFirst = (a: { filed: string; accession_no: string }, b: typeof a) =>
  byString(b.filed, a.filed) || byString(b.accession_no, a.accession_no)

function ref(row: {
  cik: string
  accession_no: string
  form: string
  filed: string
  source_url: string
  fetched_at: string
}): ProspectusFilingRef {
  return {
    accession_no: row.accession_no,
    form: row.form,
    filed: row.filed,
    filing_url: filingIndexUrl(row.cik, row.accession_no),
    source_url: row.source_url,
    fetched_at: row.fetched_at,
  }
}

/** Pure: per (start, end) the newest filing's statement, lines aligned across periods. */
export function buildStatement(rows: readonly StatementRow[]): StatementView {
  const byPeriod = new Map<string, StatementRow[]>()
  for (const row of rows) {
    const key = `${row.start}\n${row.end}`
    byPeriod.set(key, [...(byPeriod.get(key) ?? []), row])
  }
  const view = (r: StatementRow): StatementPeriodView => ({
    ...ref(r),
    start: r.start,
    end: r.end,
    days: daysBetween(r.start, r.end),
    unaudited: r.unaudited === true,
    units: r.units,
  })
  const shown: StatementRow[] = []
  const older: StatementRow[] = []
  for (const list of byPeriod.values()) {
    const [first, ...rest] = [...list].sort(newestFirst)
    shown.push(first!)
    older.push(...rest)
  }
  const order = (a: StatementRow, b: StatementRow) =>
    byString(b.end, a.end) ||
    daysBetween(b.start, b.end) - daysBetween(a.start, a.end) ||
    newestFirst(a, b)
  shown.sort(order)
  older.sort(order)

  // Line order and labels from the newest filing that prints each line.
  const lines: Omit<StatementLineView, 'values'>[] = []
  for (const row of [...shown].sort(newestFirst)) {
    for (const l of row.lines) {
      if (!lines.some((x) => x.key === l.key))
        lines.push({ key: l.key, label: l.label, unit: l.unit })
    }
  }
  const valueOf = (row: StatementRow, key: string) =>
    row.lines.find((l) => l.key === key)?.val ?? null
  const keys = new Set(lines.map((l) => l.key))
  const gross = keys.has('gross_profit')
    ? shown.map((r) => {
        const gp = valueOf(r, 'gross_profit')
        const rev = valueOf(r, 'revenue')
        return gp !== null && rev ? gp / rev : null
      })
    : null

  return {
    periods: shown.map(view),
    lines: lines.map((l) => ({ ...l, values: shown.map((r) => valueOf(r, l.key)) })),
    gross_margin: gross,
    not_printed: OPTIONAL_LINES.filter((k) => !keys.has(k)).map((k) => OPTIONAL_LABELS[k]),
    superseded: older.map((r) => ({
      ...view(r),
      lines: r.lines.map((l) => ({ key: l.key, label: l.label, unit: l.unit, val: l.val })),
    })),
  }
}

/** Pure: each schedule and as-of date from the newest filing that states it. */
export function buildCommitments(rows: readonly CommitmentRow[]): CommitmentView[] {
  const byKey = new Map<string, CommitmentRow>()
  for (const row of [...rows].sort(newestFirst)) {
    const key = `${row.schedule}\n${row.as_of ?? row.accession_no}`
    if (!byKey.has(key)) byKey.set(key, row)
  }
  // An undated aggregate speaks as of its filing.
  const when = (r: CommitmentRow) => r.as_of ?? r.filed
  return [...byKey.values()]
    .sort(
      (a, b) =>
        byString(when(b), when(a)) ||
        SCHEDULE_ORDER.indexOf(a.schedule) - SCHEDULE_ORDER.indexOf(b.schedule),
    )
    .map((r) => ({
      ...ref(r),
      schedule: r.schedule,
      as_of: r.as_of,
      audited: r.audited,
      approximate: r.approximate,
      statement: r.statement,
      lines: r.lines,
    }))
}

/** Pure: the newest filing's headings and each filing's against the one before it, newest first. */
export function buildRiskFactors(
  rows: readonly RiskFactorsRow[],
): ProspectusIssuerView['risk_factors'] | null {
  const sorted = [...rows].sort(newestFirst)
  const latest = sorted[0]
  if (!latest) return null
  const diffs: RiskFactorDiffView[] = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    diffs.push({
      from: ref(sorted[i + 1]!),
      to: ref(sorted[i]!),
      changes: riskFactorChanges(sorted[i + 1]!, sorted[i]!),
    })
  }
  return {
    latest: {
      ...ref(latest),
      count: latest.sections.reduce((n, s) => n + s.headings.length, 0),
      sections: latest.sections,
    },
    diffs,
  }
}

type Stored = { type: string; payload: string; source_url: string; fetched_at: string }

/** A stored payload with its provenance put back, validated; null when it does not parse. */
function read<T>(schema: z.ZodType<T>, row: Stored): T | null {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const parsed = schema.safeParse({
    ...payload,
    source_url: row.source_url,
    fetched_at: row.fetched_at,
  })
  return parsed.success ? parsed.data : null
}

export async function queryProspectus(db: PipelineDb, ctx: QueryContext): Promise<ProspectusData> {
  const [rows, stamps] = await Promise.all([
    db
      .select({
        type: tables.entities.entity_type,
        provider: tables.entities.provider,
        payload: tables.entities.payload,
        source_url: tables.entities.source_url,
        fetched_at: tables.entities.fetched_at,
      })
      .from(tables.entities)
      .where(inArray(tables.entities.entity_type, [...DETAIL_TYPES])),
    sourceStamps(db),
  ])

  const issuers: ProspectusIssuerView[] = []
  for (const provider of PROVIDER_ORDER) {
    const mine = rows.filter((r) => r.provider === provider)
    const of = <T>(type: string, schema: z.ZodType<T>) =>
      mine
        .filter((r) => r.type === type)
        .map((r) => read<T>(schema, r))
        .filter((r): r is T => r !== null)
    const statements = of<StatementRow>('statement', StatementRow)
    if (!statements.length) continue
    const commitments = of<CommitmentRow>('commitment', CommitmentRow)
    const concentration = of<ConcentrationRow>('concentration', ConcentrationRow)
    const shares = of<SharesRow>('shares', SharesRow).sort(newestFirst)[0] ?? null
    const risk = buildRiskFactors(of<RiskFactorsRow>('risk_factors', RiskFactorsRow))
    if (!risk) continue

    const filings = [
      ...new Map(
        [...statements, ...commitments, ...concentration]
          .sort(newestFirst)
          .map((r) => [r.accession_no, ref(r)] as const),
      ).values(),
    ]
    const newest = [...statements].sort(newestFirst)[0]!
    const concentrationViews: ConcentrationView[] = []
    for (const basis of ['revenue', 'accounts_receivable'] as const) {
      const row = concentration.filter((r) => r.basis === basis).sort(newestFirst)[0]
      if (row) {
        concentrationViews.push({
          ...ref(row),
          basis,
          columns: row.columns,
          customers: row.customers,
        })
      }
    }
    const sources: SourceRef[] = [...stamps.keys()]
      .filter((id) => id.startsWith(prospectusSourcePrefix(provider)))
      .sort((a, b) => byString(b.slice(-20), a.slice(-20)))
      .map((id) => ({
        source_id: id,
        label: labelOf(id).label,
        source_url: stamps.get(id)!.newest.source_url,
        fetched_at: stamps.get(id)!.newest.fetched_at,
      }))

    issuers.push({
      provider: provider as LabId,
      display: PROVIDER_DISPLAY[provider],
      cik: newest.cik,
      entity_name: newest.entity_name,
      filings,
      statement: buildStatement(statements),
      commitments: buildCommitments(commitments),
      concentration: concentrationViews,
      shares: shares
        ? {
            ...ref(shares),
            lines: shares.lines,
            before_as_of: shares.before_as_of,
            before: shares.before,
          }
        : null,
      risk_factors: risk,
      sources,
    })
  }

  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    issuers,
    rule: PROSPECTUS_RULE,
  }
}
