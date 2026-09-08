import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading } from './md-table'

// anthropic-models-md — https://platform.claude.com/docs/en/models/overview.md
// Catalog parser: the "Compare models" table is transposed (features as
// rows, one column per current model). It contributes the fields the
// pricing page does not print — context window, description — plus the
// vendor's own API ids. model_slug is taken from the printed "Claude API
// alias" row: the alias is the durable key across snapshot re-pins (the
// pinned "Claude API ID" for Haiku 4.5 carries a date suffix), and it
// matches anthropic-pricing-md's slugs so the two sources join on modelKey.

function stripLinks(cell: string): string {
  return cell.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
}

function featureRow(rows: string[][], feature: string): string[] {
  const row = rows.find((r) => stripLinks(r[0] ?? '') === feature)
  if (!row) throw new Error(`compare-models table has no "${feature}" row`)
  return row
}

// "$10 / input MTok, $50 / output MTok"
const PRICING_CELL = /^\$(\d+(?:\.\d+)?) \/ input MTok, \$(\d+(?:\.\d+)?) \/ output MTok$/

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseAnthropicModelsOverviewMd(
  text: string,
  prov: Provenance = fixtureProvenance('anthropic-models-md'),
) {
  const table = tableAfterHeading(text, '## Compare models')
  const header = table[0]
  if (!header || header.length < 2) throw new Error('compare-models table has no model columns')

  const descriptions = featureRow(table, 'Description')
  const pricing = featureRow(table, 'Pricing')
  const aliases = featureRow(table, 'Claude API alias')
  const contexts = featureRow(table, 'Context window')

  const rows: PriceRow[] = []
  for (let col = 1; col < header.length; col++) {
    const slug = (aliases[col] ?? '').replace(/`/g, '').trim()
    if (!slug) throw new Error(`no Claude API alias in column ${col} (${header[col]})`)
    const priceCell = (pricing[col] ?? '').trim()
    const m = priceCell.match(PRICING_CELL)
    if (!m) throw new Error(`unrecognized pricing cell for ${slug}: ${priceCell}`)
    rows.push({
      provider: 'anthropic',
      model_slug: slug,
      tier: null,
      context_window: (contexts[col] ?? '').trim(), // as printed ("1M tokens", "200K tokens")
      input_per_mtok: Number(m[1]),
      cached_input_per_mtok: null, // cache-read price is a footnote multiplier here, not a printed number
      output_per_mtok: Number(m[2]),
      currency: 'USD',
      effective_from: null,
      effective_until: null,
      notes: (descriptions[col] ?? '').trim() || null,
      ...prov,
    })
  }

  rows.sort((a, b) => (a.model_slug < b.model_slug ? -1 : a.model_slug > b.model_slug ? 1 : 0))
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'anthropic-models-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/anthropic-models-overview.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseAnthropicModelsOverviewMd(text),
})
