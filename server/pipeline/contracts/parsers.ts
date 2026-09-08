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

// ---- Status pages (capacity strain) ---------------------------------------

// One row per incident the vendor posted. Vocabulary is stored VERBATIM per
// feed and never mapped across vendors: Statuspage impact is
// none/minor/major/critical and its status investigating/identified/
// monitoring/resolved/postmortem; Google Cloud severity is low/medium/high
// and its status is the most recent update's (AVAILABLE once resolved).
// `updated_at` is deliberately absent — Statuspage re-stamps it on every
// posted update, and a row that changed only there is not a change.
export const IncidentRow = z.strictObject({
  provider: providerEnum,
  incident_id: z.string().min(1),
  title: z.string().min(1),
  impact: z.string().min(1),
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
export const OpenRouterRankingsOutput = z.strictObject({
  rows: z.array(RankingRow),
  // meta.as_of — the dataset build time, carried on the run, not in each
  // row's hash (it advances daily and would mark every row modified).
  as_of: provenanceFields.fetched_at,
})

export const parserOutputSchemas = {
  'openai-ashby': AshbyJobsOutput,
  'anthropic-greenhouse': GreenhouseJobsOutput,
  'xai-greenhouse': GreenhouseJobsOutput,
  'openai-models-md': VendorMdPricingOutput,
  'anthropic-models-md': VendorMdPricingOutput,
  'anthropic-pricing-md': VendorMdPricingOutput,
  'xai-models-md': VendorMdPricingOutput,
  'google-pricing-html': GooglePricingOutput,
  'edgar-fts': EdgarFtsOutput,
  'edgar-submissions-spcx': EdgarSubmissionsOutput,
  'openai-status': StatuspageIncidentsOutput,
  'anthropic-status': StatuspageIncidentsOutput,
  'google-cloud-status': GoogleCloudIncidentsOutput,
  'openrouter-models': OpenRouterOutput,
  'openrouter-rankings-daily': OpenRouterRankingsOutput,
} as const
export type ParserId = keyof typeof parserOutputSchemas
