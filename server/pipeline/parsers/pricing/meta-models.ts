import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading } from './md-table'

// meta-models-md — https://dev.meta.ai/docs/models.md
// Catalog parser: prints no prices (they come from meta-pricing-md), so every
// price field stays null. What it adds is which ids Model API serves and
// their context window. Each model line that is on Model API has a
// "### <line> availability" table whose rows name an id in backticks and say
// whether pay-as-you-go serves it; a row with no id ("Muse Wonder Full") or
// "Not available" there is a Muse Code-only variant and is not an API SKU.
// Lines without that table (Muse Image, Voice, SAM, the open-weight Muse
// Glimmer) are not token-priced text models and are not parsed.

const AVAILABILITY = /^### (.+) availability$/
const API_COLUMN = 'Model API (pay-as-you-go)'
const NOT_AVAILABLE = 'Not available'
// "has a 1,048,576-token context window" / "have a 1,048,576-token context window"
const CONTEXT = /\b([\d,]+)-token context window/
const PREVIEW_NOTE = '> **NOTE: Preview**'

/** The body of a `## ` section, heading excluded, up to the next `## `. */
function section(text: string, heading: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) throw new Error(`heading not found: ${heading}`)
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l.trim()))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseMetaModelsMd(
  text: string,
  prov: Provenance = fixtureProvenance('meta-models-md'),
) {
  const rows: PriceRow[] = []
  for (const heading of text.split('\n').map((l) => l.trim())) {
    const line = heading.match(AVAILABILITY)?.[1]
    if (!line) continue

    const body = section(text, `## ${line}`)
    const context = body.match(CONTEXT)?.[1]
    if (!context) throw new Error(`${line}: no context window printed`)
    const preview = body.includes(PREVIEW_NOTE)

    const table = tableAfterHeading(text, heading)
    if (table[0]?.[1] !== API_COLUMN) {
      throw new Error(`${heading}: second column is not "${API_COLUMN}": ${table[0]?.[1]}`)
    }
    for (const cells of table.slice(1)) {
      const api = cells[1] ?? ''
      if (api === NOT_AVAILABLE) continue
      const id = cells[0]!.match(/`([^`]+)`/)?.[1]
      if (!id) throw new Error(`${heading}: API-available row names no id: ${cells[0]}`)
      const name = cells[0]!.replace(/\s*\(`[^`]+`\)\s*$/, '')
      rows.push({
        provider: 'meta',
        model_slug: id,
        tier: null,
        context_window: `${context} tokens`, // as printed
        input_per_mtok: null, // page prints no prices — stays null, never guessed
        cached_input_per_mtok: null,
        output_per_mtok: null,
        currency: 'USD',
        effective_from: null,
        effective_until: null,
        notes: [name, `Model API: ${api}`, ...(preview ? ['preview'] : [])].join('; '),
        ...prov,
      })
    }
  }
  if (rows.length === 0) throw new Error('no "### <line> availability" table found')

  rows.sort((a, b) => (a.model_slug < b.model_slug ? -1 : a.model_slug > b.model_slug ? 1 : 0))
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'meta-models-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/meta-models.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseMetaModelsMd(text),
})
