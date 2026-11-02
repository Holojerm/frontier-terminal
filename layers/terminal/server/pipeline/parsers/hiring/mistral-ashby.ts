import { AshbyJobsOutput, registerParser, type Provenance } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { parseOpenaiAshby } from './openai-ashby'

// Mistral job board via Ashby's posting API — the same payload shape as
// OpenAI's board, so the rows come from that parser with the provider
// swapped. The board is named "mistral.ai", not "mistral" (sources.yaml).

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseMistralAshby(
  fixtureText: string,
  prov: Provenance = fixtureProvenance('mistral-ashby'),
) {
  const { rows } = parseOpenaiAshby(fixtureText, prov)
  return AshbyJobsOutput.parse({ rows: rows.map((r) => ({ ...r, provider: 'mistral' })) })
}

registerParser({
  name: 'mistral-ashby',
  lane: 'hiring',
  fixturePath: 'fixtures/hiring/mistral-ashby.json',
  sideFixturePaths: [],
  schema: AshbyJobsOutput,
  parse: (text) => parseMistralAshby(text),
})
