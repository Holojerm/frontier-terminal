import {
  GreenhouseJobsOutput,
  registerParser,
  type Provenance,
} from '#layers/core/server/utils/contracts'
import { fixtureProvenance } from '#layers/core/server/utils/fixture-provenance'
import { parseGreenhouseBoard } from './common'

// xAI job board via Greenhouse. Every row carries company_name "SpaceXAI", an
// entity-blended SpaceX/xAI artifact of the 2025 merger (sources.yaml caveat).
// greenhouseRow passes it through verbatim; rewriting it would misrepresent the board as
// pure xAI hiring.
//
// As on Anthropic's board, department comes only from the /departments join. The join is
// also the evidence behind the caveat's second sentence: the department set is entirely
// xAI-shaped (Data Center, Human Data, Model, Safety…), with no aerospace or launch
// function. A missing join fails loudly, since a silent null would also weaken the entity
// evidence the SpaceXAI caveat rests on.

const DEPARTMENTS_FIXTURE = 'fixtures/hiring/xai-greenhouse-departments.json'

export function parseXaiGreenhouse(
  fixtureText: string,
  departmentsText: string,
  prov: Provenance = fixtureProvenance('xai-greenhouse'),
) {
  return parseGreenhouseBoard('xai', fixtureText, departmentsText, prov)
}

registerParser({
  name: 'xai-greenhouse',
  lane: 'hiring',
  fixturePath: 'fixtures/hiring/xai-greenhouse.json',
  sideFixturePaths: [DEPARTMENTS_FIXTURE],
  schema: GreenhouseJobsOutput,
  parse: (text, side) => parseXaiGreenhouse(text, side(DEPARTMENTS_FIXTURE)),
})
