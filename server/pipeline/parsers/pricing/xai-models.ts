import {
  registerParser,
  VendorMdPricingOutput,
  modelKey,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading, usdAmount } from './md-table'

// xai-models-md — https://docs.x.ai/developers/models.md
// "### Text API Pricing" only: it is the $/MTok table. xAI prints DUAL rows
// per long-context model — "(< 200k prompt tokens)" and "(≥ 200k prompt
// tokens)" — kept as two rows under the same model_slug with tier
// "standard" / "long_context"; modelKey(provider, slug, tier) keeps them
// distinct and they are never collapsed or averaged. The Imagine ($/image,
// $/sec) and Voice ($/min, $/hr, $/1M chars) tables are not $/MTok token
// pricing and are deliberately not parsed into PriceRow.

// "grok-4.6 (< 200k prompt tokens)"
const DUAL_ROW = /^(.+?) \((<|≥) 200k prompt tokens\)$/u

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseXaiModelsMd(
  text: string,
  prov: Provenance = fixtureProvenance('xai-models-md'),
) {
  const table = tableAfterHeading(text, '### Text API Pricing')

  const rows: PriceRow[] = []
  for (const cells of table.slice(1)) {
    if (cells.length < 5) throw new Error(`text pricing row has ${cells.length} cells`)
    const m = cells[0]!.match(DUAL_ROW)
    if (!m) throw new Error(`unrecognized xAI model cell: ${cells[0]}`)
    rows.push({
      provider: 'xai',
      model_slug: m[1]!,
      tier: m[2] === '<' ? 'standard' : 'long_context',
      context_window: cells[1]!, // as printed ("500k", "1M", "256k")
      input_per_mtok: usdAmount(cells[2]!),
      cached_input_per_mtok: usdAmount(cells[3]!),
      output_per_mtok: usdAmount(cells[4]!),
      currency: 'USD',
      effective_from: null,
      effective_until: null,
      notes: null,
      ...prov,
    })
  }

  rows.sort((a, b) => {
    const ka = modelKey(a.provider, a.model_slug, a.tier)
    const kb = modelKey(b.provider, b.model_slug, b.tier)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'xai-models-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/xai-models.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseXaiModelsMd(text),
})
