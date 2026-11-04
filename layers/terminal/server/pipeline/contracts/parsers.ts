import { z } from 'zod'
import { provenanceFields } from './provenance'
import { providerEnum } from './rows'

// One output schema per parser (one per Include-verdict source in
// sources.yaml). A parser is done when parse(fixture) validates against
// its schema.

// ---- Hiring ---------------------------------------------------------------

const jobRowCore = {
  provider: providerEnum,
  job_id: z.string().min(1), // Ashby UUID or Greenhouse numeric id as string
  title: z.string().min(1),
  department: z.string().nullable(), // Ashby: inline; Greenhouse: from /departments join
  team: z.string().nullable(), // Ashby only
  location: z.string().nullable(),
  employment_type: z.string().nullable(),
  published_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  // xAI caveat travels with the data: every xai row carries "SpaceXAI"
  // (entity-blended board) and the UI must surface it.
  company_name: z.string().nullable(),
  ...provenanceFields,
} as const

export const AshbyJobRow = z.strictObject(jobRowCore)
export const AshbyJobsOutput = z.strictObject({ rows: z.array(AshbyJobRow) })

export const GreenhouseJobRow = z.strictObject(jobRowCore)
export const GreenhouseJobsOutput = z.strictObject({ rows: z.array(GreenhouseJobRow) })

// Google's careers feed (XML): the same row shape, one lab-scoped employer.
export const CareersFeedJobRow = z.strictObject(jobRowCore)
export const CareersFeedJobsOutput = z.strictObject({ rows: z.array(CareersFeedJobRow) })

// ---- Pricing + catalog ----------------------------------------------------

export const PriceRow = z.strictObject({
  provider: providerEnum,
  model_slug: z.string().min(1),
  // Disambiguates multi-row SKUs: xAI "long_context", Google
  // standard/batch/flex/priority. Part of the stable key (modelKey).
  tier: z.string().nullable(),
  context_window: z.string().nullable(), // as printed ("500k", "1M") — normalize downstream
  input_per_mtok: z.number().nonnegative().nullable(),
  cached_input_per_mtok: z.number().nonnegative().nullable(),
  output_per_mtok: z.number().nonnegative().nullable(),
  currency: z.literal('USD'),
  // Google dual-date promo strings become two rows bounded by these.
  effective_from: z.string().nullable(),
  effective_until: z.string().nullable(),
  notes: z.string().nullable(),
  ...provenanceFields,
})
export type PriceRow = z.infer<typeof PriceRow>

// Vendor .md parsers (openai / anthropic / xai) — deterministic.
export const VendorMdPricingOutput = z.strictObject({ rows: z.array(PriceRow) })

// Google pricing — the one agent-parsed source. Same row shape; provider
// pinned. This schema IS the validation gate agent output must pass.
export const GooglePricingOutput = z.strictObject({
  rows: z.array(PriceRow.extend({ provider: z.literal('google') })),
})

// What the model is actually ASKED for: the row minus its provenance.
// source_url/fetched_at are never the model's to supply — code stamps them
// from the fetch record, the same rule the judge lane follows for
// id/rule/created_at/provenance. A field code can determine is a field the
// model cannot get wrong, cannot be talked into changing by page content,
// and does not spend output tokens writing.
export const GooglePricingAgentOutput = z.strictObject({
  rows: z.array(
    PriceRow.omit({ source_url: true, fetched_at: true }).extend({
      provider: z.literal('google'),
    }),
  ),
})

// ---- SEC ------------------------------------------------------------------

export const FilingRow = z.strictObject({
  accession_no: z.string().min(1),
  form: z.string().min(1),
  file_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ciks: z.array(z.string().min(1)).min(1),
  display_names: z.array(z.string()),
  // Set only when a CIK matches the sources.yaml whitelist; open FTS hits
  // are audit-confirmed noisy and never alert on their own.
  whitelist_cik: z.string().nullable(),
  ...provenanceFields,
})
export type FilingRow = z.infer<typeof FilingRow>
export const EdgarFtsOutput = z.strictObject({ rows: z.array(FilingRow) })
export const EdgarSubmissionsOutput = z.strictObject({ rows: z.array(FilingRow) })

// ---- Resolved filers (pending_filers × EDGAR hits) -------------------------

// A lab's CIK read off its own registration filing: the earliest S-1-family
// hit whose filer name matches the lab's pending_filers pattern. `name` is
// EDGAR's display name for the filer, verbatim; the resolving filing is
// named so the resolution is checkable from the row alone.
export const FilerRow = z.strictObject({
  provider: providerEnum,
  cik: z.string().regex(/^\d{10}$/),
  name: z.string().min(1),
  resolved_form: z.string().min(1),
  resolved_accession: z.string().min(1),
  resolved_file_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ...provenanceFields,
})
export type FilerRow = z.infer<typeof FilerRow>

// ---- Revenue (XBRL company facts) -----------------------------------------

// One duration fact from data.sec.gov/api/xbrl/companyfacts, or from one
// filing's XBRL instance (parsers/sec/xbrl-segment.ts): the filer's value for
// one revenue tag over one period, as one filing reported it. Values are the
// filer's own XBRL numbers in USD, never scaled or rounded; `tag` travels with
// the row because filers switch tags between years and the reader, not the
// parser, decides which tag a period is read from. `segment` is the
// StatementBusinessSegmentsAxis member a segment fact was reported on, absent
// on a consolidated fact — absent rather than null so the companyfacts rows
// keep the content hash they were stored under.
export const RevenueRow = z.strictObject({
  cik: z.string().regex(/^\d{10}$/),
  entity_name: z.string().min(1),
  // 'prospectus': read off the statement of operations printed in a
  // registration filing whose XBRL tags no financials (prospectus-revenue.ts);
  // `tag` is then the statement's own row label, verbatim.
  taxonomy: z.enum(['us-gaap', 'prospectus']),
  tag: z.string().min(1),
  unit: z.literal('USD'),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  val: z.number(),
  accession_no: z.string().min(1),
  fy: z.int().nullable(),
  fp: z.string().nullable(), // FY, Q1..Q4 as the filer tagged it
  form: z.string().min(1),
  filed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  frame: z.string().nullable(), // SEC's calendar frame (CY2026Q2) when the fact is the canonical one for it
  segment: z
    .string()
    .regex(/^[a-z][a-z0-9-]*:[A-Za-z0-9]+Member$/)
    .optional(),
  whitelist_cik: z.string().nullable(),
  // Set only on a prospectus row for an interim period: registration
  // statements print interim financials unaudited. Absent on XBRL rows.
  unaudited: z.literal(true).optional(),
  ...provenanceFields,
})
export type RevenueRow = z.infer<typeof RevenueRow>
export const EdgarCompanyfactsOutput = z.strictObject({ rows: z.array(RevenueRow) })
export const XbrlSegmentOutput = z.strictObject({ rows: z.array(RevenueRow) })
export const ProspectusRevenueOutput = z.strictObject({ rows: z.array(RevenueRow) })

// The primary document of one registration filing, read off EDGAR's filing
// index (filing-index.ts): the name a prospectus-revenue source is derived
// from. The submissions feed lists the accession but not the document.
export const RegistrationDocumentRow = z.strictObject({
  provider: providerEnum,
  cik: z.string().regex(/^\d{10}$/),
  entity_name: z.string().min(1),
  accession_no: z.string().regex(/^\d{10}-\d{2}-\d{6}$/),
  form: z.string().min(1),
  filed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  document: z.string().regex(/^[A-Za-z0-9._-]+\.htm$/),
  ...provenanceFields,
})
export type RegistrationDocumentRow = z.infer<typeof RegistrationDocumentRow>
export const FilingIndexOutput = z.strictObject({ rows: z.array(RegistrationDocumentRow) })

// The offering terms one registration filing's cover states
// (prospectus-offering.ts). Every field is read off the filing itself; null
// is "the cover leaves it blank", which on a preliminary prospectus is the
// news: the range is set in the amendment that starts the roadshow.
export const OfferingRow = z.strictObject({
  provider: providerEnum,
  cik: z.string().regex(/^\d{10}$/),
  entity_name: z.string().min(1),
  accession_no: z.string().regex(/^\d{10}-\d{2}-\d{6}$/),
  form: z.string().min(1),
  filed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** "AMENDMENT NO. 1 TO FORM S-1" -> 1; null on an original filing. */
  amendment_no: z.int().positive().nullable(),
  /** The estimated range per share, in USD; both null while the cover leaves it blank. */
  price_low: z.number().positive().nullable(),
  price_high: z.number().positive().nullable(),
  /** A final prospectus's (424B4) offering price per share. */
  price: z.number().positive().nullable(),
  exchange: z.string().min(1).nullable(),
  symbol: z.string().min(1).nullable(),
  ...provenanceFields,
})
export type OfferingRow = z.infer<typeof OfferingRow>

// ---- What else a registration document prints ------------------------------
//
// Read off the same document as the revenue and the cover terms
// (parsers/sec/prospectus-*.ts), so every row names its filing. A figure the
// document leaves blank is null, never an estimate; a section the document
// does not print yields no row.

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const filingFields = {
  provider: providerEnum,
  cik: z.string().regex(/^\d{10}$/),
  entity_name: z.string().min(1),
  accession_no: z.string().regex(/^\d{10}-\d{2}-\d{6}$/),
  form: z.string().min(1),
  filed: ymd,
} as const

// One row of the statement of operations for one period. `key` is the
// canonical name when the label is one the parser knows (revenue,
// total_operating_expenses, operating_income, net_income, …), else the label
// slugged; `label` is the statement's own words. `val` is in dollars, shares
// or dollars per share as printed, negative where the statement prints
// parentheses, and null where it prints a dash.
export const StatementLine = z.strictObject({
  key: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string().min(1),
  val: z.number().nullable(),
  unit: z.enum(['USD', 'USD/share', 'shares']),
})
export type StatementLine = z.infer<typeof StatementLine>

// The whole statement of operations for one period, as one filing printed it
// (prospectus-statement.ts). One row per (filing, period), like revenue: a
// later filing's statement for the same period is a new row, not an overwrite.
export const StatementRow = z.strictObject({
  ...filingFields,
  start: ymd,
  end: ymd,
  // Set only on an interim period: registration statements print them unaudited.
  unaudited: z.literal(true).optional(),
  /** The statement's units line, verbatim. */
  units: z.string().min(1),
  lines: z.array(StatementLine).min(1),
  ...provenanceFields,
})
export type StatementRow = z.infer<typeof StatementRow>

// A contractual-commitment schedule (prospectus-commitments.ts):
//   - 'contractual_obligations': MD&A's table, every obligation by year due;
//   - 'purchase_commitments': the commitments note's audited schedule of
//     non-cancelable purchase commitments by year;
//   - 'purchase_commitments_interim': the note's one-sentence interim total;
//   - 'obligations_aggregate': MD&A's one-sentence total of the table plus
//     short-term and subsequent commitments and leases not yet commenced.
// Bucket labels are the document's ("2026", "Thereafter"). `approximate`
// marks a figure the document itself calls approximate; `statement` is the
// sentence a one-figure schedule was read from, verbatim.
export const CommitmentLine = z.strictObject({
  label: z.string().min(1),
  total: z.number(),
  buckets: z.array(z.strictObject({ label: z.string().min(1), val: z.number() })),
})
export type CommitmentLine = z.infer<typeof CommitmentLine>

export const CommitmentRow = z.strictObject({
  ...filingFields,
  schedule: z.enum([
    'contractual_obligations',
    'purchase_commitments',
    'purchase_commitments_interim',
    'obligations_aggregate',
  ]),
  /** The date the schedule is stated as of; null when the sentence names none. */
  as_of: ymd.nullable(),
  audited: z.boolean(),
  approximate: z.boolean(),
  statement: z.string().min(1).nullable(),
  lines: z.array(CommitmentLine).min(1),
  ...provenanceFields,
})
export type CommitmentRow = z.infer<typeof CommitmentRow>

// Customers at or above 10% of revenue or of accounts receivable, from the
// notes' concentration tables (prospectus-concentration.ts). Customers are
// named as the filing names them ("Customer A"). A null share is the
// filing's "*": under the 10% threshold, not zero.
export const ConcentrationRow = z.strictObject({
  ...filingFields,
  basis: z.enum(['revenue', 'accounts_receivable']),
  /** Revenue columns are periods; receivables columns are balances, start null. */
  columns: z
    .array(z.strictObject({ start: ymd.nullable(), end: ymd, unaudited: z.boolean() }))
    .min(1),
  customers: z
    .array(
      z.strictObject({
        label: z.string().min(1),
        pct: z.array(z.number().min(0).max(100).nullable()),
      }),
    )
    .min(1),
  ...provenanceFields,
})
export type ConcentrationRow = z.infer<typeof ConcentrationRow>

// Share counts from "The Offering" summary (prospectus-shares.ts): shares
// offered and outstanding after the offering per row of that table, and the
// pre-offering basis sentence's counts. A preliminary prospectus leaves most
// counts blank until the price range is set; a blank is null.
export const SharesRow = z.strictObject({
  ...filingFields,
  lines: z
    .array(
      z.strictObject({
        label: z.string().min(1),
        shares: z.int().nonnegative().nullable(),
        /** The count if the underwriters exercise their option in full, where the row states one. */
        with_option: z.int().nonnegative().nullable(),
      }),
    )
    .min(1),
  /** The date the pre-offering counts are stated as of. */
  before_as_of: ymd.nullable(),
  before: z.array(
    z.strictObject({ label: z.string().min(1), shares: z.int().nonnegative().nullable() }),
  ),
  ...provenanceFields,
})
export type SharesRow = z.infer<typeof SharesRow>

// The risk-factor headings one filing prints, grouped under its "Risks
// Related to …" subsections, verbatim and in order (prospectus-risk-factors.ts).
// What an amendment added or removed is computed against the previous
// filing's row (prospectus-floor.ts › riskFactorChanges).
export const RiskFactorsRow = z.strictObject({
  ...filingFields,
  sections: z
    .array(
      z.strictObject({
        title: z.string().min(1),
        headings: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  ...provenanceFields,
})
export type RiskFactorsRow = z.infer<typeof RiskFactorsRow>

// Everything the prospectus lane reads from one registration document.
export const ProspectusOutput = z.strictObject({
  revenue: z.array(RevenueRow),
  offering: OfferingRow.nullable(),
  statements: z.array(StatementRow).min(1),
  commitments: z.array(CommitmentRow),
  concentration: z.array(ConcentrationRow),
  shares: SharesRow.nullable(),
  risk_factors: RiskFactorsRow,
})
export type ProspectusOutput = z.infer<typeof ProspectusOutput>

// ---- Status pages (capacity strain) ---------------------------------------

// One row per incident the vendor posted. Vocabulary is stored VERBATIM per
// feed and never mapped across vendors: Statuspage impact is
// none/minor/major/critical and its status investigating/identified/
// monitoring/resolved/postmortem; Google Cloud severity is low/medium/high
// and its status is the most recent update's (AVAILABLE once resolved).
// `impact` is null where the feed publishes none (Statuspage's Atom history,
// anthropic-status): never inferred from an update's wording.
// `updated_at` is deliberately absent — Statuspage re-stamps it on every
// posted update, and a row that changed only there is not a change.
export const IncidentRow = z.strictObject({
  provider: providerEnum,
  incident_id: z.string().min(1),
  title: z.string().min(1),
  impact: z.string().min(1).nullable(),
  status: z.string().min(1),
  started_at: z.string().min(1),
  resolved_at: z.string().nullable(), // null while open
  // Statuspage component names / Google affected_products titles, sorted.
  components: z.array(z.string().min(1)),
  incident_url: z.url({ protocol: /^https?$/ }),
  ...provenanceFields,
})
export type IncidentRow = z.infer<typeof IncidentRow>
export const StatuspageIncidentsOutput = z.strictObject({ rows: z.array(IncidentRow) })
export const GoogleCloudIncidentsOutput = z.strictObject({
  rows: z.array(IncidentRow.extend({ provider: z.literal('google') })),
})
// status.x.ai's RSS history: one item per (component, incident), folded to one row per incident.
export const XaiStatusIncidentsOutput = z.strictObject({
  rows: z.array(IncidentRow.extend({ provider: z.literal('xai') })),
})

// ---- Misalignment disclosures ---------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const entryId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

// One row per entry on a disclosure index. Everything a reader sees is the
// page's own text, stored verbatim: the title, the one-sentence summary, the
// model and the context it was observed in. `listed_on` is the date the index
// prints beside the entry; it moves when a report is revised, so a change
// there alone never wakes the judge (judge/pending.ts), but it is kept,
// because the earliest one observed is the report's publication date.
export const DisclosureRow = z.strictObject({
  provider: providerEnum,
  kind: z.enum(['report', 'notice']),
  entry_id: entryId, // report slug, or the notice's id without its "notice-" prefix
  title: z.string().min(1),
  summary: z.string().min(1),
  model: z.string().min(1).nullable(), // reports only
  observed_during: z.string().min(1).nullable(), // reports only
  listed_on: isoDate,
  entry_url: z.url({ protocol: /^https?$/ }),
  ...provenanceFields,
})
export type DisclosureRow = z.infer<typeof DisclosureRow>
export const DisclosureIndexOutput = z.strictObject({ rows: z.array(DisclosureRow) })

// The dates on one report's own page. `lines` is every "Label: value" line of
// the page's metadata cell, verbatim and in page order, minus "Report
// updated" (the index row carries that date). Two dates are read out of it,
// and only when the value is exactly one date: the discovery date, under any
// of the labels the vendor uses, and a printed disclosure date. The
// occurrence line ("Sample", "Incident date", ...) is only ever verbatim.
export const DisclosureTimelineRow = z.strictObject({
  provider: providerEnum,
  entry_id: entryId,
  title: z.string().min(1), // the page's own title; the read side joins on it
  lines: z.array(z.strictObject({ label: z.string().min(1), value: z.string().min(1) })),
  discovered_on: isoDate.nullable(),
  disclosed_on: isoDate.nullable(),
  ...provenanceFields,
})
export type DisclosureTimelineRow = z.infer<typeof DisclosureTimelineRow>
export const DisclosureReportPageOutput = z.strictObject({
  rows: z.array(DisclosureTimelineRow).length(1),
})

// ---- Cross-check (never source of record) ---------------------------------

export const OpenRouterModelRow = z.strictObject({
  or_model_id: z.string().min(1), // e.g. "anthropic/..."
  provider: providerEnum,
  prompt_per_tok: z.number().nonnegative().nullable(),
  completion_per_tok: z.number().nonnegative().nullable(),
  context_length: z.int().nullable(),
  ...provenanceFields,
})
export const OpenRouterOutput = z.strictObject({ rows: z.array(OpenRouterModelRow) })

// ---- Demand share (OpenRouter usage rankings, CC BY 4.0) ------------------

export const RankingRow = z.strictObject({
  provider: providerEnum,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // UTC day bucket
  model_permaslug: z.string().min(1), // e.g. "anthropic/claude-sonnet-4.5"
  // Arrives as a decimal string; a number here so share arithmetic never
  // silently concatenates. Safe-integer bounded: a day of tokens on one
  // aggregator is ~1e12, far under 2^53.
  total_tokens: z.int().nonnegative(),
  ...provenanceFields,
})
export type RankingRow = z.infer<typeof RankingRow>

// One mapped matrix cell (layers/terminal/server/utils/terminal-classes.ts) checked against
// the live body of the page its sentence was transcribed from
// (layers/terminal/server/pipeline/recommendations.ts). `present` is the whole verdict: the
// sentence is either on the page, byte for byte after link-flattening, or it
// is not — nothing is inferred about what replaced it.
export const RecommendationRow = z.strictObject({
  provider: providerEnum,
  class: z.string().min(1),
  model_slug: z.string().min(1),
  basis: z.string().min(1),
  present: z.boolean(),
  ...provenanceFields,
})
export type RecommendationRow = z.infer<typeof RecommendationRow>
export const OpenRouterRankingsOutput = z.strictObject({
  rows: z.array(RankingRow),
  // meta.as_of — the dataset build time, carried on the run, not in each
  // row's hash (it advances daily and would mark every row modified).
  as_of: provenanceFields.fetched_at,
})

export const parserOutputSchemas = {
  'openai-ashby': AshbyJobsOutput,
  'mistral-ashby': AshbyJobsOutput,
  'anthropic-greenhouse': GreenhouseJobsOutput,
  'xai-greenhouse': GreenhouseJobsOutput,
  'google-careers': CareersFeedJobsOutput,
  'openai-models-md': VendorMdPricingOutput,
  'openai-pricing-md': VendorMdPricingOutput,
  // One registration for every derived per-model page (derived.ts); the
  // committed fixture is one representative page.
  'openai-model-md-gpt-5.6-sol': VendorMdPricingOutput,
  'anthropic-models-md': VendorMdPricingOutput,
  'anthropic-pricing-md': VendorMdPricingOutput,
  'xai-models-md': VendorMdPricingOutput,
  'google-pricing-html': GooglePricingOutput,
  // One registration for every derived per-model page (derived.ts); the
  // committed fixture is one representative page.
  'google-model-md-gemini-4-argon': GooglePricingOutput,
  'meta-models-md': VendorMdPricingOutput,
  'meta-pricing-md': VendorMdPricingOutput,
  'mistral-models-md': VendorMdPricingOutput,
  'mistral-pricing-md': VendorMdPricingOutput,
  'edgar-fts': EdgarFtsOutput,
  'edgar-fts-openai': EdgarFtsOutput,
  'edgar-submissions-spcx': EdgarSubmissionsOutput,
  'edgar-submissions-msft': EdgarSubmissionsOutput,
  'edgar-submissions-amzn': EdgarSubmissionsOutput,
  'edgar-submissions-nvda': EdgarSubmissionsOutput,
  'edgar-submissions-googl': EdgarSubmissionsOutput,
  'edgar-submissions-meta': EdgarSubmissionsOutput,
  'edgar-submissions-orcl': EdgarSubmissionsOutput,
  'edgar-companyfacts-spcx': EdgarCompanyfactsOutput,
  // One registration each for every derived filing-index and
  // prospectus-revenue source (derived.ts); the fixtures are Anthropic's S-1.
  'filing-index-anthropic-s-1-2026-10-26-0001628280-26-067168': FilingIndexOutput,
  'prospectus-revenue-anthropic-s-1-2026-10-26-0001628280-26-067168': ProspectusRevenueOutput,
  // The whole lane on the amendment: everything a registration document is read for.
  'prospectus-revenue-anthropic-s-1-a-2026-11-02-0001628280-26-068676': ProspectusOutput,
  // One registration for every derived per-filing segment instance
  // (derived.ts); the committed fixture is one representative 10-Q.
  'xbrl-segment-googl-2026-10-29-0001652044-26-000084': XbrlSegmentOutput,
  'openai-status': StatuspageIncidentsOutput,
  'anthropic-status': StatuspageIncidentsOutput,
  'google-cloud-status': GoogleCloudIncidentsOutput,
  'mistral-status': StatuspageIncidentsOutput,
  'xai-status': XaiStatusIncidentsOutput,
  'openai-misalignment-reports': DisclosureIndexOutput,
  // One registration for every derived per-report page (derived.ts); the
  // committed fixture is one representative page.
  'openai-misalignment-report-an-agent-used-dns-to-reach-an-external-chatbot':
    DisclosureReportPageOutput,
  'openrouter-models': OpenRouterOutput,
  'openrouter-rankings-daily': OpenRouterRankingsOutput,
} as const
export type ParserId = keyof typeof parserOutputSchemas
