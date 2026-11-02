import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading } from './md-table'

// mistral-models-md — https://docs.mistral.ai/models.md
// Catalog parser: prints no prices (they come from mistral-pricing-md), so
// every price field stays null. Only the first table (current models) is
// read; the deprecated-and-retired table below it is not a catalog. A row
// with no API name (Shieldstral, Timestral) is not callable and is skipped.
//
// Mistral resells other labs' models on its API. The page labels each one
// "A third-party … model from <maker>" in its summary; those rows are never
// Mistral SKUs. The pricing page carries no such label, so it skips the same
// rows by maker name — THIRD_PARTY_MAKERS — and this parser is where that
// list is checked against the page's own word: a third-party row from an
// unlisted maker, or a listed maker's row without the label, fails the parse.

export const THIRD_PARTY_MAKERS = ['Z.ai', 'DeepSeek'] as const

/** Whether a model's display name starts with a maker Mistral resells. */
export const isThirdPartyName = (name: string): boolean =>
  THIRD_PARTY_MAKERS.some((maker) => name.startsWith(`${maker} `))

const HEADING = '# Models Overview'
const HEADER = ['Model', 'API name', 'Status', 'Context', 'Summary']
const THIRD_PARTY = /\bthird-party\b/i

/** "[Mistral Large 4](/models/mistral-large-4-0)" -> "Mistral Large 4". */
export const linkText = (cell: string): string => cell.match(/^\[([^\]]+)\]/)?.[1] ?? cell

/** "`mistral-large-4`" -> "mistral-large-4"; an empty cell -> null. */
export const apiName = (cell: string): string | null => cell.match(/^`([^`]+)`$/)?.[1] ?? null

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseMistralModelsMd(
  text: string,
  prov: Provenance = fixtureProvenance('mistral-models-md'),
) {
  const table = tableAfterHeading(text, HEADING)
  if (table[0]?.join('|') !== HEADER.join('|')) {
    throw new Error(`${HEADING}: unrecognized header ${table[0]?.join('|')}`)
  }

  const rows: PriceRow[] = []
  for (const cells of table.slice(1)) {
    const [model = '', api = '', status = '', context = '', summary = ''] = cells
    const name = linkText(model)
    const labelled = THIRD_PARTY.test(summary)
    if (labelled !== isThirdPartyName(name)) {
      throw new Error(
        labelled
          ? `${name}: labelled third-party, but its maker is not in THIRD_PARTY_MAKERS`
          : `${name}: named for a third-party maker, but not labelled third-party`,
      )
    }
    if (labelled) continue

    const slug = apiName(api)
    if (!slug) {
      if (api !== '') throw new Error(`${name}: unrecognized API name cell: ${api}`)
      continue
    }
    rows.push({
      provider: 'mistral',
      model_slug: slug,
      tier: null,
      context_window: context === '' || context === '--' ? null : context, // as printed
      input_per_mtok: null, // page prints no prices — stays null, never guessed
      cached_input_per_mtok: null,
      output_per_mtok: null,
      currency: 'USD',
      effective_from: null,
      effective_until: null,
      notes: `${name}; ${status}`,
      ...prov,
    })
  }
  if (rows.length === 0) throw new Error('no current model with an API name found')

  rows.sort((a, b) => (a.model_slug < b.model_slug ? -1 : a.model_slug > b.model_slug ? 1 : 0))
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'mistral-models-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/mistral-models.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseMistralModelsMd(text),
})
