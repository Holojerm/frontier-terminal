// The reported-figures payload (the "Reported in the press" panel on /revenue):
// each private lab's revenue, valuation and funding as press headlines state
// them, the newest report and a median per quarter, kept apart from anything
// filed. A headline syndicated to many outlets counts once, at its earliest
// copy. Only figures the judge read as `reported` feed the series; talks and
// forecasts are listed, never averaged in.
//
// Every table read here is append-only, so `as_of` is a cut on found_at,
// judged_at and figures_at.

import { and, count, inArray, isNotNull, isNull, lte, max, eq } from 'drizzle-orm'

import type {
  LabId,
  ReportedBasis,
  ReportedData,
  ReportedHeadline,
  ReportedMetric,
  ReportedQuarter,
  ReportedSeries,
} from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import { GKG_FROM } from '../pipeline/track-record/gkg'
import { earliestPerHeadline } from '../pipeline/reported/review'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../pipeline/store'
import type { QueryContext } from './terminal-db'

/** Headlines listed under "recent". */
export const RECENT_LIMIT = 30

/** Quarters shown per series. */
export const QUARTERS_SHOWN = 4

/** A cache variant: the newest article, reading and backfilled file, which the poll stamp does not see. */
export async function reportedStamp(db: PipelineDb): Promise<string> {
  const [[a], [r], [f]] = await Promise.all([
    db.select({ at: max(tables.reportedArticles.found_at) }).from(tables.reportedArticles),
    db.select({ at: max(tables.reportedReviews.judged_at) }).from(tables.reportedReviews),
    db.select({ at: max(tables.gdeltFiles.figures_at) }).from(tables.gdeltFiles),
  ])
  return `${a?.at ?? 'none'}|${r?.at ?? 'none'}|${f?.at ?? 'none'}`
}

/** 2026-11-02T18:15:00Z -> 2026-Q4 */
export function quarterOf(iso: string): string {
  return `${iso.slice(0, 4)}-Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`
}

/** The middle value; the mean of the middle two for an even count. */
export function middle(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** One series per lab, metric and currency from `reported` figures, newest report first. */
export function seriesOf(headlines: readonly ReportedHeadline[]): ReportedSeries[] {
  const groups = new Map<string, ReportedHeadline[]>()
  for (const h of headlines) {
    if (h.basis !== 'reported') continue
    const key = `${h.lab}|${h.metric}|${h.currency}`
    groups.set(key, [...(groups.get(key) ?? []), h])
  }
  const out: ReportedSeries[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => b.published_at.localeCompare(a.published_at))
    const byQuarter = new Map<string, number[]>()
    for (const h of group) {
      const q = quarterOf(h.published_at)
      byQuarter.set(q, [...(byQuarter.get(q) ?? []), h.amount])
    }
    const quarters: ReportedQuarter[] = [...byQuarter.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, QUARTERS_SHOWN)
      .map(([quarter, amounts]) => ({
        quarter,
        median: middle(amounts),
        low: Math.min(...amounts),
        high: Math.max(...amounts),
        reports: amounts.length,
      }))
    const latest = group[0]!
    out.push({
      lab: latest.lab,
      metric: latest.metric,
      currency: latest.currency,
      latest,
      quarters,
    })
  }
  return out.sort(
    (a, b) => a.lab.localeCompare(b.lab) || METRIC_ORDER[a.metric] - METRIC_ORDER[b.metric],
  )
}

const METRIC_ORDER: Readonly<Record<ReportedMetric, number>> = {
  revenue_run_rate: 0,
  revenue: 1,
  valuation: 2,
  funding: 3,
  funding_total: 4,
}

export async function queryReported(db: PipelineDb, ctx: QueryContext): Promise<ReportedData> {
  const at = ctx.at
  const [figures, articles, [read], [waiting]] = await Promise.all([
    db
      .select()
      .from(tables.reportedFigures)
      .where(at ? lte(tables.reportedFigures.judged_at, at) : undefined),
    db
      .select()
      .from(tables.reportedArticles)
      .where(at ? lte(tables.reportedArticles.found_at, at) : undefined),
    db
      .select({ n: count() })
      .from(tables.gdeltFiles)
      .where(
        at
          ? and(isNotNull(tables.gdeltFiles.figures_at), lte(tables.gdeltFiles.figures_at, at))
          : isNotNull(tables.gdeltFiles.figures_at),
      ),
    db
      .select({ n: count() })
      .from(tables.gdeltFiles)
      .where(and(eq(tables.gdeltFiles.status, 'ok'), isNull(tables.gdeltFiles.figures_at))),
  ])

  const copies = new Map<string, Set<string>>()
  for (const a of articles) {
    copies.set(a.title_key, (copies.get(a.title_key) ?? new Set()).add(a.outlet))
  }
  const earliest = new Map(earliestPerHeadline(articles).map((a) => [a.title_key, a]))

  const reviewed = new Set<string>()
  for (const group of chunk([...earliest.keys()], D1_MAX_BOUND_PARAMS - 1)) {
    const rows = await db
      .select({ title_key: tables.reportedReviews.title_key })
      .from(tables.reportedReviews)
      .where(
        at
          ? and(
              inArray(tables.reportedReviews.title_key, group),
              lte(tables.reportedReviews.judged_at, at),
            )
          : inArray(tables.reportedReviews.title_key, group),
      )
    for (const r of rows) reviewed.add(r.title_key)
  }

  const headlines: ReportedHeadline[] = []
  for (const f of figures) {
    const article = earliest.get(f.title_key)
    if (!article) continue
    headlines.push({
      lab: f.lab as LabId,
      metric: f.metric as ReportedMetric,
      basis: f.basis as ReportedBasis,
      currency: f.currency as 'USD' | 'EUR',
      amount: f.amount,
      amount_text: f.amount_text,
      period: f.period,
      title: article.title,
      outlet: article.outlet,
      url: article.url,
      published_at: article.published_at,
      outlets: copies.get(f.title_key)?.size ?? 1,
      source_url: article.url,
      fetched_at: article.fetched_at,
    })
  }
  headlines.sort((a, b) => b.published_at.localeCompare(a.published_at))

  return {
    series: seriesOf(headlines),
    recent: headlines.slice(0, RECENT_LIMIT),
    coverage: {
      from: GKG_FROM,
      files_read: read?.n ?? 0,
      // A point-in-time payload can't rewind a file that was waiting then; it reports today's.
      files_waiting: waiting?.n ?? 0,
      unread: [...earliest.keys()].filter((k) => !reviewed.has(k)).length,
    },
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
  }
}
