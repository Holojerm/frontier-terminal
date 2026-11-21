import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// ─────────────────────────────────────────────
// Who powers the lab sites (layers/terminal/server/power/, /api/power-sites)
// ─────────────────────────────────────────────
// One row per company a public page ties to one of Epoch AI's lab sites, and
// one per site whose grid a page names (role `grid`). `basis` is hand (read by
// a person into curated/power-sites.json and copied here) or judge (read by
// the judge from an SEC document the filings lane found and stored, and
// checked word for word by the Worker). `fetched_at` is the last time the page
// was fetched and the quote found on it. A row from an SEC filing ends when the
// filer's next document of the same periodic form, naming the site, no longer
// has its quote; a row from any other page is re-checked weekly
// (power/verify.ts) and spools an ops event when its quote is gone.
export const powerSiteTies = sqliteTable(
  'power_site_ties',
  {
    id: text('id').primaryKey(),
    site: text('site').notNull(),
    // utility | generation | equipment | host | grid
    role: text('role').notNull(),
    company_name: text('company_name').notNull(),
    parent: text('parent'),
    ticker: text('ticker'),
    unlisted: text('unlisted'),
    mw: real('mw'),
    mw_meaning: text('mw_meaning'),
    source_title: text('source_title'),
    publisher: text('publisher'),
    published: text('published'),
    quote: text('quote').notNull(),
    basis: text('basis').notNull(), // hand | judge
    accession_no: text('accession_no'),
    // Not exported: what a later filing is compared on. The SEC form of the
    // document at source_url when it is a filing's main document (10-Q, 10-K,
    // 8-K, S-1/A), null for an exhibit or a page off EDGAR; and its filing date.
    form: text('form'),
    filed: text('filed'),
    first_seen_at: text('first_seen_at').notNull(),
    ended_at: text('ended_at'),
    ended_by: text('ended_by'),
    ...provenance,
  },
  (t) => [index('power_site_ties_site_idx').on(t.site, t.ended_at)],
)

// One row per SEC document EDGAR full-text search found naming a lab site, per
// site it was found for (power/ingest.ts). A document is fetched once: a filing
// does not change after it is accepted. `excerpts` counts the runs of its text
// around the site's name that speak of power; a document with any is offered
// to the judge until `judged_at` is set (power/review.ts).
export const powerSiteDocuments = sqliteTable(
  'power_site_documents',
  {
    // EDGAR's id for the file: <accession>:<file name>.
    document_id: text('document_id').notNull(),
    site: text('site').notNull(),
    accession_no: text('accession_no').notNull(),
    cik: text('cik').notNull(),
    // The filer as EDGAR displays it: "TERAWULF INC.  (WULF)  (CIK 0001083301)".
    filer: text('filer').notNull(),
    form: text('form').notNull(),
    // The form for a main document, EX-99.1 and the like for an exhibit.
    file_type: text('file_type').notNull(),
    filed: text('filed').notNull(),
    // The site's names it was searched for (JSON array): the excerpts are cut around them.
    terms: text('terms').notNull(),
    // read | failed
    status: text('status').notNull(),
    detail: text('detail'),
    raw_key: text('raw_key'),
    excerpts: integer('excerpts').notNull(),
    judged_at: text('judged_at'),
    ...provenance,
  },
  (t) => [
    primaryKey({ columns: [t.document_id, t.site] }),
    index('power_site_documents_site_idx').on(t.site, t.filed),
  ],
)
