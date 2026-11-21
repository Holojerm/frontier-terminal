import {
  StatuspageIncidentsOutput,
  registerParser,
  type Provenance,
} from '#layers/core/server/utils/contracts'
import { fixtureProvenance } from '#layers/core/server/utils/fixture-provenance'
import { parseStatuspageIncidents } from './statuspage'

// openai-status — status.openai.com incidents (Statuspage v2). No component
// field on this page, so a row says "OpenAI posted an incident", not which
// surface (sources.yaml caveat).

// One-argument calls read the fixture's provenance, keeping the determinism gate byte-identical.
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
