import {
  registerParser,
  VendorMdPricingOutput,
  type PriceRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { tableAfterHeading } from './md-table'

// moonshot-models-md — https://platform.kimi.ai/docs/models.md
// Catalog only. Moonshot's price tables (platform.kimi.ai/docs/pricing/chat)
// are drawn in the browser: the served .md and HTML both carry an empty
// <table>, so no price is read and every price field stays null — the cut
// `moonshot-pricing` says why. Only the "Multi-modal Model" table (the models
// open to new users) is a catalog; the "Deprecated Models" table under it is
// not read. The page prints no context column, so context_window stays null.

const HEADING = '## Multi-modal Model'
const HEADER = ['Model Name', 'Description']

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseMoonshotModelsMd(
  text: string,
  prov: Provenance = fixtureProvenance('moonshot-models-md'),
) {
  const table = tableAfterHeading(text, HEADING)
  if (table[0]?.join('|') !== HEADER.join('|')) {
    throw new Error(`${HEADING}: unrecognized header ${table[0]?.join('|')}`)
  }

  const rows: PriceRow[] = []
  // The page writes its separator row with one dash per cell ("| - | - |"),
  // which the shared reader keeps as a row.
  const body = table.slice(1).filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c)))
  for (const [name = '', description = ''] of body) {
    const slug = name.match(/^`([a-z0-9][a-z0-9.-]*)`$/)?.[1]
    if (!slug) throw new Error(`unrecognized model name cell: ${name}`)
    rows.push({
      provider: 'moonshot',
      model_slug: slug,
      tier: null,
      context_window: null,
      input_per_mtok: null, // the served page prints no price — stays null, never guessed
      cached_input_per_mtok: null,
      output_per_mtok: null,
      currency: 'USD',
      effective_from: null,
      effective_until: null,
      notes: description || null,
      ...prov,
    })
  }
  if (rows.length === 0) throw new Error('no current model found')

  rows.sort((a, b) => (a.model_slug < b.model_slug ? -1 : a.model_slug > b.model_slug ? 1 : 0))
  return VendorMdPricingOutput.parse({ rows })
}

registerParser({
  name: 'moonshot-models-md',
  lane: 'vendor-md',
  fixturePath: 'fixtures/pricing/moonshot-models.md',
  sideFixturePaths: [],
  schema: VendorMdPricingOutput,
  parse: (text) => parseMoonshotModelsMd(text),
})
