import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from './columns'

// ─────────────────────────────────────────────
// Reported figures: lab revenue, valuations and funding rounds as press
// headlines state them (pipeline/reported/). Append-only, like the track record.

// One row per GDELT article whose headline names a private lab, an amount and
// a financial word, taken from the rows the press side keeps (gkg_mentions). Syndicated copies share a title_key; the judge reads each
// headline once, whatever the number of outlets that carried it.
export const reportedArticles = sqliteTable(
  'reported_articles',
  {
    id: text('id').primaryKey(),
    title_key: text('title_key').notNull(),
    title: text('title').notNull(),
    outlet: text('outlet').notNull(),
    url: text('url').notNull(),
    published_at: text('published_at').notNull(),
    found_at: text('found_at').notNull(),
    // GDELT's GKGRECORDID: with source_url, finds the row in its file. Rows aren't kept whole.
    record_id: text('record_id').notNull(),
    ...provenance,
  },
  (t) => [
    index('reported_articles_key_idx').on(t.title_key, t.published_at),
    index('reported_articles_found_idx').on(t.found_at, t.id),
  ],
)

// One row per headline the judge read: how many figures it found (0 when the
// headline states none we track).
export const reportedReviews = sqliteTable(
  'reported_reviews',
  {
    id: text('id').primaryKey(),
    title_key: text('title_key').notNull(),
    figures: integer('figures').notNull(),
    judged_at: text('judged_at').notNull(),
    // When the headline was read for deal sizes (review.ts). Null for one read
    // before deals were labeled, until the judge reads it again for them.
    deals_at: text('deals_at'),
  },
  (t) => [index('reported_reviews_judged_idx').on(t.judged_at, t.id)],
)

// One row per figure a headline states, as the judge labeled it and the
// Worker checked it: the amount and the lab are in the headline.
export const reportedFigures = sqliteTable(
  'reported_figures',
  {
    id: text('id').primaryKey(),
    title_key: text('title_key').notNull(),
    article_id: text('article_id').notNull(),
    lab: text('lab').notNull(),
    // revenue_run_rate | revenue | valuation | funding | funding_total, or a
    // deal: commitment | commitment_total | investment | financing
    metric: text('metric').notNull(),
    basis: text('basis').notNull(), // reported | sought | projected
    // The other company in a deal, as the headline names it. Null otherwise.
    counterparty: text('counterparty'),
    currency: text('currency').notNull(), // USD | EUR
    amount: real('amount').notNull(),
    amount_text: text('amount_text').notNull(),
    period: text('period'),
    published_at: text('published_at').notNull(),
    judged_at: text('judged_at').notNull(),
    ...provenance,
  },
  (t) => [
    index('reported_figures_lab_idx').on(t.lab, t.metric, t.published_at),
    index('reported_figures_judged_idx').on(t.judged_at, t.id),
  ],
)
