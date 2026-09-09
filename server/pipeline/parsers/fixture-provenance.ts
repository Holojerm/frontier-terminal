import type { Provenance } from '../contracts'
import manifest from '../../../fixtures/manifest.json'

// Provenance for committed fixtures comes from fixtures/manifest.json — the
// one record of the scaffold-time fetches. Never fabricated, never hardcoded
// in a parser. Imported as a module (no filesystem) so the same lookup works
// inside a Worker and inside workerd tests.

export interface ManifestFixture {
  path: string
  source_id: string
  source_url: string
  fetched_at: string
}

export const manifestFixtures: readonly ManifestFixture[] = manifest.fixtures

export function fixtureProvenance(sourceId: string): Provenance {
  const entry = manifestFixtures.find((e) => e.source_id === sourceId)
  if (!entry) {
    throw new Error(`fixtures/manifest.json has no entry for source id: ${sourceId}`)
  }
  return { source_url: entry.source_url, fetched_at: entry.fetched_at }
}
