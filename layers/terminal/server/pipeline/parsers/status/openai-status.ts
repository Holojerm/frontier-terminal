import { StatuspageIncidentsOutput, registerParser, type Provenance } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { parseStatuspageIncidents } from './statuspage'

// openai-status — status.openai.com incidents (Statuspage v2). No component
// field on this page, so a row says "OpenAI posted an incident", not which
// surface (sources.yaml caveat).

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseOpenaiStatus(
  text: string,
  prov: Provenance = fixtureProvenance('openai-status'),
) {
  return parseStatuspageIncidents('openai', text, prov)
}

registerParser({
  name: 'openai-status',
  lane: 'status',
  fixturePath: 'fixtures/status/openai-status.json',
  sideFixturePaths: [],
  schema: StatuspageIncidentsOutput,
  parse: (text) => parseOpenaiStatus(text),
})
