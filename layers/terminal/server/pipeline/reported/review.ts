// The judge's half of reported figures. GET /api/judge/pending offers each
// unread headline as a FIGURE REVIEW entry; POST /api/judge/alerts sends back
// the figures it states, labeled. A label is kept only when its amount is one
// the headline writes, its lab is one the headline names, any period's year
// is in the headline, and a deal's other company is named there as written.
// A headline is read once: syndicated copies share its title_key, and the
// earliest copy stands for all of them. One read before deal sizes were
// labeled and that uses a deal word is offered a second time, and only the
// deals of that second reading are kept.

import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '#server/db/schema'
import { contentHash } from '../contracts'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../store'
import {
  DEAL_WORDS,
  REPORTED_LABS,
  amountsIn,
  labsIn,
  type Amount,
  type ReportedLab,
} from './figures'

/** Headlines offered per run. */
export const FIGURE_REVIEW_LIMIT = 60

export const FIGURE_METRICS = [
  'revenue_run_rate',
  'revenue',
  'valuation',
  'funding',
  'funding_total',
] as const

/**
 * Deal sizes. commitment: what the lab agreed to buy from one company.
 * investment: what one company put into the lab. financing: what one company
 * lends it. commitment_total: everything the lab has agreed to buy, from all.
 */
export const DEAL_METRICS = ['commitment', 'investment', 'financing', 'commitment_total'] as const
export type DealMetric = (typeof DEAL_METRICS)[number]

export const METRICS = [...FIGURE_METRICS, ...DEAL_METRICS] as const
export type Metric = (typeof METRICS)[number]

export const isDealMetric = (metric: string): metric is DealMetric =>
  (DEAL_METRICS as readonly string[]).includes(metric)

/** A deal with one other company, which the label must name. */
const namesCounterparty = (metric: string) => isDealMetric(metric) && metric !== 'commitment_total'

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
  /** The other company in a deal, exactly as the headline names it. Null for every other figure. */
  counterparty: z.string().min(2).max(60).nullable().default(null),
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

/** Each read headline's key, with when it was read for deals (null: before deals were labeled). */
async function reviewedKeys(
  db: PipelineDb,
  keys: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  for (const group of chunk([...new Set(keys)], D1_MAX_BOUND_PARAMS)) {
    const rows = await db
      .select({
        title_key: tables.reportedReviews.title_key,
        deals_at: tables.reportedReviews.deals_at,
      })
      .from(tables.reportedReviews)
      .where(inArray(tables.reportedReviews.title_key, group))
    for (const r of rows) out.set(r.title_key, r.deals_at)
  }
  return out
}

/** True for a headline read before deals were labeled that may state one. */
const needsDealReading = (title: string, deals_at: string | null | undefined) =>
  deals_at === null && DEAL_WORDS.test(title)

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

/**
 * The FIGURE REVIEW block: unread headlines, oldest first, then headlines to
 * read again for deals, at most `limit`.
 */
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
  return [
    ...heads.filter((a) => !done.has(a.title_key)),
    ...heads.filter((a) => needsDealReading(a.title, done.get(a.title_key))),
  ]
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
  if (namesCounterparty(figure.metric)) {
    const other = figure.counterparty
    if (!other || !title.includes(other)) {
      return { reason: 'counterparty-not-in-headline', detail: other ?? figure.metric }
    }
    if (labsIn(other).includes(figure.lab)) {
      return { reason: 'counterparty-is-the-lab', detail: other }
    }
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
    // Read already: a second reading counts only for a headline still owed one for deals.
    const reread = done.has(article.title_key)
    if (reread && !needsDealReading(article.title, done.get(article.title_key))) continue
    const failure = reading.figures
      .map((f) => figureFailure(article.title, f))
      .find((f) => f !== null)
    if (failure) {
      report.rejected.push({ ...failure, article_id: reading.article_id })
      continue
    }
    report.accepted++
    done.set(article.title_key, judged_at)
    const amounts = amountsIn(article.title)
    const figures = new Map<string, typeof tables.reportedFigures.$inferInsert>()
    for (const f of reading.figures) {
      // The first reading's revenue, valuation and funding labels stand.
      if (reread && !isDealMetric(f.metric)) continue
      const amount = amounts.find((a) => a.text === f.amount)!
      const counterparty = namesCounterparty(f.metric) ? f.counterparty : null
      const id = contentHash({
        title_key: article.title_key,
        lab: f.lab,
        metric: f.metric,
        basis: f.basis,
        amount: f.amount,
        ...(counterparty ? { counterparty } : {}),
      })
      figures.set(id, {
        id,
        title_key: article.title_key,
        article_id: article.id,
        lab: f.lab,
        metric: f.metric,
        basis: f.basis,
        counterparty,
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
    const written = reread
      ? await db
          .update(tables.reportedReviews)
          .set({ deals_at: judged_at })
          .where(
            and(
              eq(tables.reportedReviews.title_key, article.title_key),
              isNull(tables.reportedReviews.deals_at),
            ),
          )
          .returning({ id: tables.reportedReviews.id })
      : await db
          .insert(tables.reportedReviews)
          .values({
            id: reviewId(article.title_key),
            title_key: article.title_key,
            figures: figures.size,
            judged_at,
            deals_at: judged_at,
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
