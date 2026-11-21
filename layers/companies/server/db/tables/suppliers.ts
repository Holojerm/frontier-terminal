import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// ─────────────────────────────────────────────
// Suppliers (layers/companies/server/suppliers/, /api/suppliers)
// ─────────────────────────────────────────────
// One row per SEC document of a supplier the filings lane read
// (suppliers/ingest.ts). A document is fetched once: a filing does not change
// after it is accepted. `excerpts` counts the runs of its text that name a
// counterparty; a document with any is offered to the judge until `judged_at`
// is set (suppliers/review.ts).
export const supplierDocuments = sqliteTable(
  'supplier_documents',
  {
    accession_no: text('accession_no').primaryKey(),
    ticker: text('ticker').notNull(),
    form: text('form').notNull(),
    filed: text('filed').notNull(),
    // The period the submissions feed gives the document (reportDate), or null.
    report_date: text('report_date'),
    // read | failed
    status: text('status').notNull(),
    detail: text('detail'),
    raw_key: text('raw_key'),
    excerpts: integer('excerpts').notNull(),
    judged_at: text('judged_at'),
    ...provenance,
  },
  (t) => [index('supplier_documents_ticker_idx').on(t.ticker, t.filed)],
)

// One row per passage in a supplier's own SEC document that ties it to a lab,
// a cloud or an unnamed customer. `basis` is hand (read by a person into
// curated/suppliers.json and copied here) or judge (read by the judge from a
// document the filings lane stored, and checked word for word by the Worker).
// `fetched_at` is the last time a document was fetched and the quote found in
// it; `source_url` is the document it was read from. A row ends when the next
// document of the same form from the same company no longer has its quote.
export const supplierPassages = sqliteTable(
  'supplier_passages',
  {
    id: text('id').primaryKey(),
    ticker: text('ticker').notNull(),
    company_name: text('company_name').notNull(),
    layer: text('layer').notNull(),
    relation: text('relation').notNull(),
    counterparty: text('counterparty').notNull(),
    counterparty_ticker: text('counterparty_ticker'),
    counterparty_lab: text('counterparty_lab'),
    figures: text('figures').notNull(), // JSON
    form: text('form').notNull(),
    filed: text('filed').notNull(),
    period: text('period'),
    source_title: text('source_title').notNull(),
    quote: text('quote').notNull(),
    alias_term: text('alias_term'),
    alias_quote: text('alias_quote'),
    basis: text('basis').notNull(), // hand | judge
    accession_no: text('accession_no'),
    first_seen_at: text('first_seen_at').notNull(),
    ended_at: text('ended_at'),
    ended_by: text('ended_by'),
    ...provenance,
  },
  (t) => [index('supplier_passages_ticker_idx').on(t.ticker, t.ended_at)],
)
