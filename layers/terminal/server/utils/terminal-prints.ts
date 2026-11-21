// The hardware prints as the route serves them: per entity, each month's
// newest figure with the first one we held where they differ, when it was
// first seen and released, and the sourced ties of the company.

import printTiesJson from '../curated/print-ties.json'

import * as tables from '#server/db/schema'
import {
  curatedPrintTies,
  PRINT_ENTITIES,
  type PrintGap,
  type PrintPoint,
  type PrintRow,
  type PrintsData,
  type PrintTie,
} from '../../shared/utils/prints'
import type { PipelineDb } from '../pipeline/store'
import type { QueryContext } from './terminal-db'

export const PRINTS_RULE =
  'Each figure is kept as a source first gave it. A later, different figure for the same month is a new row, so a revision never replaces what was printed. first_seen_at is when our read first held it; published_at is the release time where the source states one. A tie is a quote from a filing or a company statement. Not investment advice.'

export const PRINT_GAPS: readonly PrintGap[] = [
  {
    id: 'tw-history',
    title: 'Taiwan history before our first read',
    reason:
      'Held for TSMC from its 6-Ks since 2015 and for Accton from its own page since July 2023. The exchange’s archive (MOPS) is closed to automated reading by its terms and robots.txt, so the other six start at our first read of the exchange feed.',
  },
  {
    id: 'kr-chip-exports',
    title: 'Korea chip exports',
    reason:
      'Korea Customs Service’s 10-day, 20-day and monthly chip export figures are not read yet. Its releases since October 2026 are open under KOGL Type 1; earlier ones carry no licence mark. The memory makers they lead are tied below.',
  },
]

export const printTies: readonly PrintTie[] = curatedPrintTies.parse(printTiesJson).ties

/** Every stored row, oldest sighting first. */
export async function printRows(db: PipelineDb): Promise<PrintRow[]> {
  const t = tables.hardwarePrints
  const rows = await db
    .select({
      series: t.series,
      entity: t.entity,
      period: t.period,
      window: t.window,
      value: t.value,
      currency: t.currency,
      yoy_pct: t.yoy_pct,
      observed_as: t.observed_as,
      vintage: t.vintage,
      first_seen_at: t.first_seen_at,
      published_at: t.published_at,
      due_on: t.due_on,
      basis: t.basis,
      source_id: t.source_id,
      source_url: t.source_url,
      fetched_at: t.fetched_at,
    })
    .from(t)
    .orderBy(t.first_seen_at, t.vintage)
  return rows as PrintRow[]
}

const earliest = (xs: (string | null)[]) =>
  xs.filter((x): x is string => x !== null).sort()[0] ?? null

/**
 * One entity's months, newest first. Each month's figure is the newest one
 * from its finest source (the exchange feed's NT$ thousand over a 6-K's NT$
 * million); first_value is that source's first figure where it later
 * changed. first_seen_at and published_at are the earliest
 * any source gave.
 */
export function buildPoints(rows: PrintRow[]): PrintPoint[] {
  const months = new Map<string, PrintRow[]>()
  for (const r of rows) {
    const key = `${r.period}|${r.window}`
    months.set(key, [...(months.get(key) ?? []), r])
  }
  const points: PrintPoint[] = []
  for (const group of months.values()) {
    const newest = [...group].sort(
      (a, b) =>
        precision(a.source_id) - precision(b.source_id) ||
        b.first_seen_at.localeCompare(a.first_seen_at) ||
        b.vintage - a.vintage,
    )[0]!
    const chain = group.filter((r) => r.source_id === newest.source_id)
    const first = chain.find((r) => r.vintage === 1) ?? null
    const stated = chain.filter((r) => r.yoy_pct !== null).at(-1)
    points.push({
      period: newest.period,
      window: newest.window,
      value: newest.value,
      first_value: first && newest.vintage > 1 ? first.value : null,
      yoy_pct: stated?.yoy_pct ?? null,
      first_seen_at: earliest(group.map((r) => r.first_seen_at))!,
      published_at: earliest(group.map((r) => r.published_at)),
      source_url: newest.source_url,
    })
  }
  return points.sort((a, b) => b.period.localeCompare(a.period) || a.window.localeCompare(b.window))
}

/** Finer first: the exchange feed and Accton print NT$ thousand, TSMC's 6-K NT$ million. */
const precision = (source_id: string) => (source_id === 'tsmc-revenue-6k' ? 1 : 0)

export function buildPrints(
  rows: PrintRow[],
  ties: readonly PrintTie[],
): Pick<PrintsData, 'series' | 'gaps'> {
  return {
    series: PRINT_ENTITIES.map((entity) => {
      const mine = rows.filter((r) => r.entity === entity.id)
      return {
        entity,
        points: buildPoints(mine),
        revisions: mine.filter((r) => r.vintage > 1).length,
        ties: ties.filter((t) => t.entity === entity.id),
      }
    }),
    gaps: [...PRINT_GAPS],
  }
}

export async function queryPrints(db: PipelineDb, ctx: QueryContext): Promise<PrintsData> {
  const rows = await printRows(db)
  return {
    as_of:
      rows
        .map((r) => r.first_seen_at)
        .sort()
        .at(-1) ?? null,
    computed_at: ctx.now().toISOString(),
    rule: PRINTS_RULE,
    ...buildPrints(rows, printTies),
  }
}
