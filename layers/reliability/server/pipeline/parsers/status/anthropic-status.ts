import {
  StatuspageIncidentsOutput,
  registerParser,
  type Provenance,
} from '#layers/core/server/utils/contracts'
import { fixtureProvenance } from '#layers/core/server/utils/fixture-provenance'
import { parseStatuspageAtom } from './statuspage-atom'

// anthropic-status — status.claude.com's Atom incident history. Its robots.txt disallows
// /api/, so the JSON API is off limits; the Atom feed carries no impact and, today, no
// component names (sources.yaml caveat). status.anthropic.com 301-redirects to this host.

// One-argument calls read the fixture's provenance, keeping the determinism gate byte-identical.
export function parseAnthropicStatus(
  text: string,
  prov: Provenance = fixtureProvenance('anthropic-status'),
) {
  return parseStatuspageAtom('anthropic', text, prov)
}

registerParser({
  name: 'anthropic-status',
  lane: 'status',
  fixturePath: 'fixtures/status/anthropic-status.xml',
  sideFixturePaths: [],
  schema: StatuspageIncidentsOutput,
  // The registry hashes the schema-shaped output; `maintenances` is a run note.
  parse: (text) => ({ rows: parseAnthropicStatus(text).rows }),
})
