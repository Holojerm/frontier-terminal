import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading } from './md-table'
import { apiName, isThirdPartyName, linkText } from './mistral-models'

// mistral-pricing-md — https://docs.mistral.ai/inference/pricing.md
// One `## <family> models` table per family, each row a model, its API name
// and one price cell whose lines are joined by <br>:
//   "Input $0.7 /M Tokens<br>Cached input $0.07 /M Tokens<br>Output $2.1 /M Tokens"
// Only the per-million-token lines are prices this terminal compares. OCR
// (per 1000 pages), audio (per minute) and TTS (per million characters)
// lines are recognised and dropped, so a row with none of the token lines is
// skipped and Voxtral Small keeps only its token lines. Every line must be
// one of those shapes: a new unit fails the parse rather than vanishing.
//
// Rows for models Mistral resells (Z.ai, DeepSeek) are skipped by maker
// name; mistral-models-md checks that list against the page's own
// "third-party" label.

const TABLE_HEADER = ['Model', 'API name', 'Price']
const TOKEN_LINE = /^(Input|Cached input|Output) \$(\d+(?:\.\d+)?) \/M Tokens$/
const OTHER_UNIT = /^Input \$\d+(?:\.\d+)? \/(?:Min|1000 Pages|1000 Annotated Pages|M Chars)$/
// Mistral Moderation 2: "Free<br>$0 /M Tokens" — no Input/Output label, so
// there is no side to file the zero under; not a comparable SKU.
const FREE = /^(?:Free|\$0 \/M Tokens)$/

type TokenLabel = 'Input' | 'Cached input' | 'Output'

/** The `## ` family headings, in page order. */
const familyHeadings = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^## /.test(l))

/** Token prices from one price cell; null when the cell prints none. */
function tokenPrices(name: string, cell: string): Map<TokenLabel, number> | null {
  const out = new Map<TokenLabel, number>()
  for (const line of cell.split('<br>').map((l) => l.trim())) {
    const m = line.match(TOKEN_LINE)
    if (m) {
      const label = m[1] as TokenLabel
      if (out.has(label)) throw new Error(`${name}: two "${label}" prices`)
      out.set(label, Number(m[2]))
      continue
    }
    if (OTHER_UNIT.test(line) || FREE.test(line)) continue
    throw new Error(`${name}: unrecognized price line: ${line}`)
  }
  if (out.size === 0) return null
  if (!out.has('Input')) throw new Error(`${name}: token prices with no Input line`)
  return out
}

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseMistralPricingMd(
  text: string,
  prov: Provenance = fixtureProvenance('mistral-pricing-md'),
) {
  const rows: PriceRow[] = []
  for (const heading of familyHeadings(text)) {
    const table = tableAfterHeading(text, heading)
    if (table[0]?.join('|') !== TABLE_HEADER.join('|')) {
      throw new Error(`${heading}: unrecognized header ${table[0]?.join('|')}`)
    }
    const family = heading.replace(/^## /, '')

    for (const [model = '', api = '', price = ''] of table.slice(1)) {
      const name = linkText(model)
      if (isThirdPartyName(name)) continue
      const slug = apiName(api)
      if (!slug) {
        // Shieldstral and Timestral print neither an API name nor a price.
        if (api !== '' || price !== '') throw new Error(`${name}: priced row with no API name`)
        continue
      }
      const prices = tokenPrices(name, price)
      if (!prices) continue
      rows.push({
        provider: 'mistral',
        model_slug: slug,
        tier: null,
        context_window: null, // not printed here (catalog: mistral-models-md)
        input_per_mtok: prices.get('Input')!,
        cached_input_per_mtok: prices.get('Cached input') ?? null,
        output_per_mtok: prices.get('Output') ?? null, // embeddings print no output price
        currency: 'USD',
        effective_from: null,
        effective_until: null,
        notes: `${name}; ${family}`,
        ...prov,
      })
    }
  }
  if (rows.length === 0) throw new Error('no token-priced model found')

  rows.sort((a, b) => (a.model_slug < b.model_slug ? -1 : a.model_slug > b.model_slug ? 1 : 0))
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'mistral-pricing-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/mistral-pricing.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseMistralPricingMd(text),
})
