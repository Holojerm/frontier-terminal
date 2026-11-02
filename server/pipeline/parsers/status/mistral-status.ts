import { StatuspageIncidentsOutput, registerParser, type Provenance } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { parseStatuspageIncidents } from './statuspage'

// mistral-status — status.mistral.ai incidents (Statuspage v2). No component
// field on this page, so Vibe and Le Chat incidents count alongside API ones
// (sources.yaml caveat).

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
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
