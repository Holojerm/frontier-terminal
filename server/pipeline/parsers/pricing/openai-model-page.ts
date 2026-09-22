import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading, usdAmount } from './md-table'

// openai-model-md-<slug> — https://developers.openai.com/api/docs/models/<slug>.md
// One page per priced Standard-tier SKU, derived from openai-pricing-md
// (server/pipeline/derived.ts). The page prints what the catalog and pricing
// pages do not — the context window, max output and knowledge cutoff — and
// the same $/MTok prices under "### Text tokens". One PriceRow, tier null,
// so it shares its key with the catalog and pricing rows and the three pages
// read as one SKU; the row carrying the window wins the catalog view.
//
// The page's own "Model ID" must equal the slug the source was derived for.
// A mismatch (a redirect, a renamed page) throws, and the source fails
// rather than storing a page under the wrong SKU.

const MODEL_ID = /^Model ID: `([^`]+)`\s*$/m
const CONTEXT_WINDOW = /^- ([\d,]+) context window\s*$/m
const CUTOFF = /^- (.+? knowledge cutoff)\s*$/m
const TEXT_TOKENS = '### Text tokens'

export function parseOpenAiModelPage(
  text: string,
  expectedSlug: string | null,
  prov: Provenance = fixtureProvenance('openai-model-md-gpt-5.6-sol'),
) {
  const slug = text.match(MODEL_ID)?.[1] ?? null
  if (!slug) throw new Error('model page prints no "Model ID"')
  if (expectedSlug !== null && slug !== expectedSlug) {
    throw new Error(`model page is for ${slug}, derived for ${expectedSlug}`)
  }

  const prices = {
    input: null as number | null,
    cached: null as number | null,
    output: null as number | null,
  }
  if (text.includes(TEXT_TOKENS)) {
    for (const cells of tableAfterHeading(text, TEXT_TOKENS).slice(1)) {
      const [metric, price, unit] = cells
      if (unit !== '1M tokens' || !metric || !price) continue // a per-image or per-minute line is not $/MTok
      if (metric === 'Input') prices.input = usdAmount(price)
      else if (metric === 'Cached input') prices.cached = usdAmount(price)
      else if (metric === 'Output') prices.output = usdAmount(price)
    }
  }

  const row: PriceRow = {
    provider: 'openai',
    model_slug: slug,
    tier: null,
    context_window: text.match(CONTEXT_WINDOW)?.[1] ?? null, // as printed ("1,050,000")
    input_per_mtok: prices.input,
    cached_input_per_mtok: prices.cached,
    output_per_mtok: prices.output,
    currency: 'USD',
    effective_from: null,
    effective_until: null,
    notes: text.match(CUTOFF)?.[1] ?? null,
    ...prov,
  }
  return VendorMdPricingOutput.parse({ rows: [row] })
}

registerParser({
  name: 'openai-model-md-gpt-5.6-sol',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/openai-model-gpt-5.6-sol.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseOpenAiModelPage(text, 'gpt-5.6-sol'),
})
