import {
  StatuspageIncidentsOutput,
  registerParser,
  type Provenance,
} from '#layers/core/server/utils/contracts'
import { fixtureProvenance } from '#layers/core/server/utils/fixture-provenance'
import { parseStatuspageIncidents } from './statuspage'

// mistral-status — status.mistral.ai incidents (Statuspage v2). No component
// field on this page, so Vibe and Le Chat incidents count alongside API ones
// (sources.yaml caveat).

// One-argument calls read the fixture's provenance, keeping the determinism gate byte-identical.
export function parseMistralStatus(
  text: string,
  prov: Provenance = fixtureProvenance('mistral-status'),
) {
  return parseStatuspageIncidents('mistral', text, prov)
}

registerParser({
  name: 'mistral-status',
  lane: 'status',
  fixturePath: 'fixtures/status/mistral-status.json',
  sideFixturePaths: [],
  schema: StatuspageIncidentsOutput,
  parse: (text) => parseMistralStatus(text),
})
