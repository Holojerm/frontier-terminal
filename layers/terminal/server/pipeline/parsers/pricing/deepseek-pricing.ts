import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading, usdAmount } from './md-table'

// deepseek-pricing-md — https://api-docs.deepseek.com/quick_start/pricing.md
// Catalog and price list in one transposed table: one column per model, one
// row per field. The page's merged header cells are repeated across the
// first three columns ("MODEL | MODEL | MODEL"), so a row is read by its
// label and the model columns are the ones after those three.
//
// Prices are USD per million tokens, in two time bands: peak (01:00–04:00 and
// 06:00–10:00 UTC on weekdays) and off-peak, which the page says is half the
// peak rate. The peak price is the list price and is stored as the standard
// row; off-peak is its own `off_peak` tier, never a discount on that row.
// The cache-miss input is the input price and the cache-hit input is the
// cached-input price. Search and Fetch are priced per request and not parsed.

const HEADING = '## Model Details'
const LABEL_COLUMNS = 3
const PRICING = 'PRICING(2)'
const INPUT_HIT = '1M INPUT TOKENS / (CACHE HIT)'
const INPUT_MISS = '1M INPUT TOKENS / (CACHE MISS)'
const OUTPUT = '1M OUTPUT TOKENS'
const BANDS = { PEAK: null, 'OFF-PEAK': 'off_peak' } as const
type Band = keyof typeof BANDS

/** "deepseek-flash(1)" -> "deepseek-flash": the footnote marker is not part of the API name. */
const modelName = (cell: string): string => {
  const name = cell.replace(/\(\d+\)$/, '')
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error(`unrecognized model column: ${cell}`)
  return name
}

/** The one row whose label cells match, or a throw: a renamed row must not read as no price. */
function row(table: string[][], ...labels: string[]): string[] {
  const hits = table.filter((cells) => labels.every((l, i) => cells[i] === l))
  if (hits.length !== 1)
    throw new Error(`expected one row ${labels.join(' / ')}, found ${hits.length}`)
  return hits[0]!
}

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseDeepseekPricingMd(
  text: string,
  prov: Provenance = fixtureProvenance('deepseek-pricing-md'),
) {
  const table = tableAfterHeading(text, HEADING)
  const header = table[0] ?? []
  if (header.slice(0, LABEL_COLUMNS).some((c) => c !== 'MODEL')) {
    throw new Error(`${HEADING}: unrecognized header ${header.join('|')}`)
  }
  const models = header.slice(LABEL_COLUMNS).map(modelName)
  if (models.length === 0) throw new Error(`${HEADING}: no model columns`)

  const version = row(table, 'MODEL VERSION')
  const context = row(table, 'CONTEXT LENGTH')
  const priced = (sub: string, band: Band) => row(table, PRICING, sub, band)

  const rows: PriceRow[] = []
  models.forEach((slug, i) => {
    const col = LABEL_COLUMNS + i
    for (const band of Object.keys(BANDS) as Band[]) {
      rows.push({
        provider: 'deepseek',
        model_slug: slug,
        tier: BANDS[band],
        context_window: context[col] || null, // as printed ("1M")
        input_per_mtok: usdAmount(priced(INPUT_MISS, band)[col] ?? ''),
        cached_input_per_mtok: usdAmount(priced(INPUT_HIT, band)[col] ?? ''),
        output_per_mtok: usdAmount(priced(OUTPUT, band)[col] ?? ''),
        currency: 'USD',
        effective_from: null,
        effective_until: null,
        notes: `${version[col] ?? ''}; ${band === 'PEAK' ? 'peak hours (the list price)' : 'off-peak hours'}`,
        ...prov,
      })
    }
  })

  rows.sort((a, b) =>
    a.model_slug !== b.model_slug
      ? a.model_slug < b.model_slug
        ? -1
        : 1
      : (a.tier ?? '') < (b.tier ?? '')
        ? -1
        : 1,
  )
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'deepseek-pricing-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/deepseek-pricing.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseDeepseekPricingMd(text),
})
