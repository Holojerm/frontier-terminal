import {
  registerParser,
  VendorMdPricingOutput,
  modelKey,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading, usdAmount } from './md-table'

// anthropic-pricing-md — https://platform.claude.com/docs/en/about-claude/pricing.md
// Two per-model $/MTok tables are parsed:
//   "## Model pricing"      -> base rows (tier null)
//   "### Batch processing"  -> tier "batch" rows (50% list discount, printed)
// Column mapping: input = "Base Input Tokens", cached input = "Cache Hits &
// Refreshes" (the price paid to READ cached input — the analog of OpenAI's
// "cached input" and xAI's "Cached input / 1M tokens"). The 5m/1h cache
// WRITE prices have no schema column; they ride verbatim in notes so a
// cache-tier repricing still changes the row's content hash and diffs.
// The fast-mode table (one combined two-model row) is deliberately not
// parsed.

// "Claude Opus 4.1 ([retired, except on Bedrock and Google Cloud](url))"
const NAME_WITH_ANNOTATION = /^(.*?)\s*\(\[([^\]]+)\]\([^)]*\)\)$/

/** Vendor slug convention, verified against the models-overview fixture's
 * "Claude API alias" row for all four current models ("Claude Haiku 4.5"
 * -> claude-haiku-4-5). INFERENCE for retired models absent from the
 * overview (e.g. claude-opus-4-1): derived, not read from a printed id. */
export function anthropicSlug(displayName: string): string {
  return displayName.toLowerCase().replace(/\./g, '-').replace(/\s+/g, '-')
}

function splitModelCell(cell: string): { name: string; annotation: string | null } {
  const m = cell.match(NAME_WITH_ANNOTATION)
  return m ? { name: m[1]!, annotation: m[2]! } : { name: cell, annotation: null }
}

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseAnthropicPricingMd(
  text: string,
  prov: Provenance = fixtureProvenance('anthropic-pricing-md'),
) {
  const rows: PriceRow[] = []

  // Header: | Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
  const base = tableAfterHeading(text, '## Model pricing')
  for (const cells of base.slice(1)) {
    if (cells.length < 6) throw new Error(`model pricing row has ${cells.length} cells`)
    const { name, annotation } = splitModelCell(cells[0]!)
    const notes = [
      ...(annotation ? [annotation] : []),
      `5m cache writes ${cells[2]!}`,
      `1h cache writes ${cells[3]!}`,
    ].join('; ')
    rows.push({
      provider: 'anthropic',
      model_slug: anthropicSlug(name),
      tier: null,
      context_window: null, // not printed on the pricing page (catalog: anthropic-models-md)
      input_per_mtok: usdAmount(cells[1]!),
      cached_input_per_mtok: usdAmount(cells[4]!),
      output_per_mtok: usdAmount(cells[5]!),
      currency: 'USD',
      effective_from: null,
      effective_until: null,
      notes,
      ...prov,
    })
  }

  // Header: | Model | Batch input | Batch output |
  const batch = tableAfterHeading(text, '### Batch processing')
  for (const cells of batch.slice(1)) {
    if (cells.length < 3) throw new Error(`batch pricing row has ${cells.length} cells`)
    const { name, annotation } = splitModelCell(cells[0]!)
    rows.push({
      provider: 'anthropic',
      model_slug: anthropicSlug(name),
      tier: 'batch',
      context_window: null,
      input_per_mtok: usdAmount(cells[1]!),
      cached_input_per_mtok: null, // batch table prints no cached-input price
      output_per_mtok: usdAmount(cells[2]!),
      currency: 'USD',
      effective_from: null,
      effective_until: null,
      notes: annotation,
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
  name: 'anthropic-pricing-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/anthropic-pricing.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseAnthropicPricingMd(text),
})
