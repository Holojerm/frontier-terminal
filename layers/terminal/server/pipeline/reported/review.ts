// The judge's half of reported figures. GET /api/judge/pending offers each
// unread headline as a FIGURE REVIEW entry; POST /api/judge/alerts sends back
// the figures it states, labeled. A label is kept only when its amount is one
// the headline writes, its lab is one the headline names, and any period's
// year is in the headline. A headline is read once: syndicated copies share
// its title_key, and the earliest copy stands for all of them.

import { asc, inArray } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '#server/db/schema'
import { contentHash } from '../contracts'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../store'
import { REPORTED_LABS, amountsIn, labsIn, type Amount, type ReportedLab } from './figures'

/** Headlines offered per run. */
export const FIGURE_REVIEW_LIMIT = 60

export const METRICS = [
  'revenue_run_rate',
  'revenue',
  'valuation',
  'funding',
  'funding_total',
] as const
export type Metric = (typeof METRICS)[number]

export const BASES = ['reported', 'sought', 'projected'] as const
export type Basis = (typeof BASES)[number]

/** A year, a quarter or a month: 2028, 2026-Q3, 2026-09. */
const PERIOD = /^\d{4}(?:-Q[1-4]|-(?:0[1-9]|1[0-2]))?$/

export const JudgeFigure = z.strictObject({
  lab: z.enum(REPORTED_LABS),
  metric: z.enum(METRICS),
  basis: z.enum(BASES),
  /** The amount exactly as the headline writes it. */
  amount: z.string().min(1).max(40),
  period: z.string().regex(PERIOD).nullable(),
})
export type JudgeFigure = z.infer<typeof JudgeFigure>

export const JudgeFigureReading = z.strictObject({
  article_id: z.string().regex(/^[0-9a-f]{64}$/),
  /** Empty when the headline states no figure we track. */
  figures: JudgeFigure.array().max(6),
})
export type JudgeFigureReading = z.infer<typeof JudgeFigureReading>

type Article = typeof tables.reportedArticles.$inferSelect

export interface FigureReview {
  article_id: string
  title: string
  outlet: string
  published_at: string
  labs: ReportedLab[]
  amounts: Amount[]
}

export const reviewId = (title_key: string) => contentHash({ title_key })

async function reviewedKeys(db: PipelineDb, keys: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const group of chunk([...new Set(keys)], D1_MAX_BOUND_PARAMS)) {
    const rows = await db
      .select({ title_key: tables.reportedReviews.title_key })
      .from(tables.reportedReviews)
      .where(inArray(tables.reportedReviews.title_key, group))
    for (const r of rows) out.add(r.title_key)
  }
  return out
}

/** The earliest copy of each headline, oldest first. */
export function earliestPerHeadline(articles: readonly Article[]): Article[] {
  const first = new Map<string, Article>()
  for (const a of articles) {
    const held = first.get(a.title_key)
    if (
      !held ||
      a.published_at < held.published_at ||
      (a.published_at === held.published_at && a.id < held.id)
    ) {
      first.set(a.title_key, a)
    }
  }
  return [...first.values()].sort(
    (a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id),
  )
}

/** The FIGURE REVIEW block: unread headlines, oldest first, at most `limit`. */
export async function figureReview(
  db: PipelineDb,
  limit: number = FIGURE_REVIEW_LIMIT,
): Promise<FigureReview[]> {
  const articles = await db
    .select()
    .from(tables.reportedArticles)
    .orderBy(asc(tables.reportedArticles.published_at))
  if (articles.length === 0) return []
  const heads = earliestPerHeadline(articles)
  const done = await reviewedKeys(
    db,
    heads.map((a) => a.title_key),
  )
  return heads
    .filter((a) => !done.has(a.title_key))
    .slice(0, limit)
    .map((a) => ({
      article_id: a.id,
      title: a.title,
      outlet: a.outlet,
      published_at: a.published_at,
      labs: labsIn(a.title),
      amounts: amountsIn(a.title),
    }))
}

export interface FigureReport {
  accepted: number
  inserted: number
  rejected: { reason: string; detail: string; article_id: string }[]
}

/** Why a label doesn't hold against its headline, or null when it does. */
export function figureFailure(
  title: string,
  figure: JudgeFigure,
): { reason: string; detail: string } | null {
  if (!labsIn(title).includes(figure.lab)) {
    return { reason: 'lab-not-in-headline', detail: figure.lab }
  }
  if (!amountsIn(title).some((a) => a.text === figure.amount)) {
    return { reason: 'amount-not-in-headline', detail: figure.amount }
  }
  if (figure.period && !title.includes(figure.period.slice(0, 4))) {
    return { reason: 'period-not-in-headline', detail: figure.period }
  }
  return null
}

/** Gate and store the figure readings of one judge run. */
export async function applyFigureReadings(
  db: PipelineDb,
  readings: readonly JudgeFigureReading[],
  now: Date,
): Promise<FigureReport> {
  const report: FigureReport = { accepted: 0, inserted: 0, rejected: [] }
  if (readings.length === 0) return report
  const articles = new Map<string, Article>()
  for (const group of chunk([...new Set(readings.map((r) => r.article_id))], D1_MAX_BOUND_PARAMS)) {
    for (const a of await db
      .select()
      .from(tables.reportedArticles)
      .where(inArray(tables.reportedArticles.id, group)))
      articles.set(a.id, a)
  }
  const done = await reviewedKeys(
    db,
    [...articles.values()].map((a) => a.title_key),
  )
  const judged_at = now.toISOString()
  for (const reading of readings) {
    const article = articles.get(reading.article_id)
    if (!article) {
      report.rejected.push({
        reason: 'unknown-article',
        detail: reading.article_id,
        article_id: reading.article_id,
      })
      continue
    }
    if (done.has(article.title_key)) continue
    const failure = reading.figures
      .map((f) => figureFailure(article.title, f))
      .find((f) => f !== null)
    if (failure) {
      report.rejected.push({ ...failure, article_id: reading.article_id })
      continue
    }
    report.accepted++
    done.add(article.title_key)
    const amounts = amountsIn(article.title)
    const figures = new Map<string, typeof tables.reportedFigures.$inferInsert>()
    for (const f of reading.figures) {
      const amount = amounts.find((a) => a.text === f.amount)!
      const id = contentHash({
        title_key: article.title_key,
        lab: f.lab,
        metric: f.metric,
        basis: f.basis,
        amount: f.amount,
      })
      figures.set(id, {
        id,
        title_key: article.title_key,
        article_id: article.id,
        lab: f.lab,
        metric: f.metric,
        basis: f.basis,
        currency: amount.currency,
        amount: amount.value,
        amount_text: f.amount,
        period: f.period,
        published_at: article.published_at,
        judged_at,
        source_url: article.url,
        fetched_at: article.fetched_at,
      })
    }
    const written = await db
      .insert(tables.reportedReviews)
      .values({
        id: reviewId(article.title_key),
        title_key: article.title_key,
        figures: figures.size,
        judged_at,
      })
      .onConflictDoNothing()
      .returning({ id: tables.reportedReviews.id })
    if (written.length === 0) continue
    if (figures.size) {
      await db
        .insert(tables.reportedFigures)
        .values([...figures.values()])
        .onConflictDoNothing()
    }
    report.inserted += figures.size
  }
  return report
}
