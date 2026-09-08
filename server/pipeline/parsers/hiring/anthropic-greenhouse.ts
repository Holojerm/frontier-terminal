import { GreenhouseJobsOutput, registerParser, type Provenance } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { parseGreenhouseBoard } from './common'

// Anthropic job board via Greenhouse. The jobs endpoint carries NO
// department field (sources.yaml caveat) — department comes only from the
// /departments join, so the parser takes both payloads.

const DEPARTMENTS_FIXTURE = 'fixtures/hiring/anthropic-greenhouse-departments.json'

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live provenance AND the live /departments payload.
export function parseAnthropicGreenhouse(
  fixtureText: string,
  departmentsText: string,
  prov: Provenance = fixtureProvenance('anthropic-greenhouse'),
) {
  return parseGreenhouseBoard('anthropic', fixtureText, departmentsText, prov)
}

registerParser({
  name: 'anthropic-greenhouse',
  lane: 'hiring',
  fixturePath: 'fixtures/hiring/anthropic-greenhouse.json',
  sideFixturePaths: [DEPARTMENTS_FIXTURE],
  schema: GreenhouseJobsOutput,
  parse: (text, side) => parseAnthropicGreenhouse(text, side(DEPARTMENTS_FIXTURE)),
})
