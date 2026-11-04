import { StatuspageIncidentsOutput, registerParser, type Provenance } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { parseStatuspageAtom } from './statuspage-atom'

// anthropic-status — status.claude.com's Atom incident history. Its
// robots.txt disallows /api/, so the JSON API this source read until
// 2026-11-04 is off limits; the Atom feed carries no impact and, today, no
// component names (sources.yaml caveat). status.anthropic.com 301-redirects
// to this host.

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
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
