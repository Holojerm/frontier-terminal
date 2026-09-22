import {
  registerParser,
  VendorMdPricingOutput,
  modelKey,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading, usdAmount } from './md-table'

// openai-pricing-md — https://developers.openai.com/api/docs/pricing.md
// The markdown twin of the platform pricing page, which did not exist at
// the 2026-08-25 audit (the marketing page is Cloudflare-403'd; the models
// page prints no prices). Four $/MTok tables, one per service tier —
// Standard, Batch, Flex, Fast — each with short- and long-context columns.
//
// One PriceRow per (model, service tier, context band). The Standard
// short-context row carries tier null so it shares modelKey with the
// catalog row from openai-models-md and the two pages read as one SKU
// (the Anthropic pair works the same way); every other band is its own
// tier and never collapsed or averaged. A "(<272K context length)"
// annotation on a model cell is the short-context bound: it is kept
// verbatim in notes, never turned into a context_window the page does not
// print. The cache-writes column has no PriceRow field and is not stored.
// The "Grouped Pricing Table" sections (cyber, audio, image, realtime,
// tools) are not the token price list and are deliberately not parsed.

const TABLES: readonly { heading: string; tier: string | null; long: string }[] = [
  { heading: '### Standard pricing data', tier: null, long: 'long_context' },
  { heading: '### Batch pricing data', tier: 'batch', long: 'batch_long_context' },
  { heading: '### Flex pricing data', tier: 'flex', long: 'flex_long_context' },
  { heading: '### Fast pricing data', tier: 'fast', long: 'fast_long_context' },
]

const HEADER = [
  'Model',
  'Short context input',
  'Short context cached input',
  'Short context cache writes',
  'Short context output',
  'Long context input',
  'Long context cached input',
  'Long context cache writes',
  'Long context output',
]

// "gpt-5.5 (<272K context length)"
const ANNOTATED = /^(\S+) \((.+)\)$/

const amount = (cell: string): number | null => (cell === '-' ? null : usdAmount(cell))

export function parseOpenAiPricingMd(
  text: string,
  prov: Provenance = fixtureProvenance('openai-pricing-md'),
) {
  const rows: PriceRow[] = []
  for (const { heading, tier, long } of TABLES) {
    const table = tableAfterHeading(text, heading)
    const header = table[0] ?? []
    if (header.join('|') !== HEADER.join('|')) {
      throw new Error(`${heading}: columns changed: ${header.join(' | ')}`)
    }
    for (const cells of table.slice(1)) {
      if (cells.length !== HEADER.length) {
        throw new Error(`${heading}: row has ${cells.length} cells: ${cells[0]}`)
      }
      const m = cells[0]!.match(ANNOTATED)
      const slug = m ? m[1]! : cells[0]!
      const annotation = m ? m[2]! : null
      const base = {
        provider: 'openai' as const,
        model_slug: slug,
        context_window: null, // the page prints a short-context bound at most, never a window
        currency: 'USD' as const,
        effective_from: null,
        effective_until: null,
        ...prov,
      }
      rows.push({
        ...base,
        tier,
        input_per_mtok: amount(cells[1]!),
        cached_input_per_mtok: amount(cells[2]!),
        output_per_mtok: amount(cells[4]!),
        notes: annotation ? `short context: ${annotation}` : null,
      })
      const longInput = amount(cells[5]!)
      const longOutput = amount(cells[8]!)
      if (longInput !== null || longOutput !== null) {
        rows.push({
          ...base,
          tier: long,
          input_per_mtok: longInput,
          cached_input_per_mtok: amount(cells[6]!),
          output_per_mtok: longOutput,
          notes: annotation ? `long context: beyond ${annotation}` : 'long context',
        })
      }
    }
  }

  rows.sort((a, b) => {
    const ka = modelKey(a.provider, a.model_slug, a.tier)
    const kb = modelKey(b.provider, b.model_slug, b.tier)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'openai-pricing-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/openai-pricing.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseOpenAiPricingMd(text),
})
