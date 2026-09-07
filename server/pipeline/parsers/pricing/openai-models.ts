import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'

// openai-models-md — https://developers.openai.com/api/docs/models.md
// The page is a catalog: model links + one-line descriptions. It prints NO
// prices and NO context windows, so every nullable price field stays null
// (price honesty rule) and the row's value is the catalog itself: which
// SKUs exist, keyed by the vendor's own slugs from the per-model .md URLs.

const CATALOG_HEADING = '## Browse our full catalog of models'
// "- [GPT-5.6 Sol](/api/docs/models/gpt-5.6-sol.md): Frontier model ..."
const ENTRY = /^- \[([^\]]+)\]\(\/api\/docs\/models\/([^)]+?)\.md\): (.+)$/

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseOpenAiModelsMd(
  text: string,
  prov: Provenance = fixtureProvenance('openai-models-md'),
) {
  const idx = text.indexOf(CATALOG_HEADING)
  if (idx === -1) throw new Error(`heading not found: ${CATALOG_HEADING}`)
  // Full-catalog section only; the "Recommended models" list above it is a
  // subset and would duplicate slugs.
  const section = text.slice(idx)

  const rows: PriceRow[] = []
  const seen = new Set<string>()
  for (const line of section.split('\n')) {
    const m = line.match(ENTRY)
    if (!m) continue
    const [, , slug, description] = m
    if (seen.has(slug!)) continue // stable keys: one row per slug
    seen.add(slug!)
    rows.push({
      provider: 'openai',
      model_slug: slug!,
      tier: null,
      context_window: null, // page prints none
      input_per_mtok: null, // page prints no prices — stays null, never guessed
      cached_input_per_mtok: null,
      output_per_mtok: null,
      currency: 'USD',
      effective_from: null,
      effective_until: null,
      notes: description!,
      ...prov,
    })
  }
  rows.sort((a, b) => (a.model_slug < b.model_slug ? -1 : a.model_slug > b.model_slug ? 1 : 0))
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'openai-models-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/openai-models.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseOpenAiModelsMd(text),
})
