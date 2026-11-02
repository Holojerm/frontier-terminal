import { StatuspageIncidentsOutput, registerParser, type Provenance } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { parseStatuspageIncidents } from './statuspage'

// anthropic-status — status.claude.com incidents (Statuspage v2, with
// components naming the surface: Claude API, claude.ai, Claude Code, ...).
// Registered at the final URL; status.anthropic.com 301-redirects here.

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseAnthropicStatus(
  text: string,
  prov: Provenance = fixtureProvenance('anthropic-status'),
) {
  return parseStatuspageIncidents('anthropic', text, prov)
}

registerParser({
  name: 'anthropic-status',
  lane: 'status',
  fixturePath: 'fixtures/status/anthropic-status.json',
  sideFixturePaths: [],
  schema: StatuspageIncidentsOutput,
  parse: (text) => parseAnthropicStatus(text),
})
