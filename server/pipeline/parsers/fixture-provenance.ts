import type { Provenance } from '../contracts'
import manifest from '../../../fixtures/manifest.json'

// Provenance for committed fixtures comes from fixtures/manifest.json — the
// one record of the scaffold-time fetches. Never fabricated, never hardcoded
// in a parser. Imported as a module (no filesystem) so the same lookup works
// inside a Worker and inside workerd tests.
//
// A fixture that could not be fetched (the endpoint needs a credential the
// scaffold did not have) carries a `constructed` block instead of fetched_at.
// Its provenance is then the documentation it was built from, at the time
// that page was read — which is what the bytes actually descend from. A
// fetched_at on a file nobody fetched would be the lie the provenance rule
// exists to prevent.

export interface ManifestFixture {
  path: string
  source_id: string
  source_url: string
  /** Absent only on a constructed fixture. */
  fetched_at?: string
  constructed?: {
    /** The documentation the fixture was built from. */
    from: string
    /** When that documentation was read. */
    fetched_at: string
    reason: string
  }
}

export const manifestFixtures: readonly ManifestFixture[] = manifest.fixtures

export function fixtureProvenance(sourceId: string): Provenance {
  const entry = manifestFixtures.find((e) => e.source_id === sourceId)
  if (!entry) {
    throw new Error(`fixtures/manifest.json has no entry for source id: ${sourceId}`)
  }
  if (entry.constructed) {
    return { source_url: entry.constructed.from, fetched_at: entry.constructed.fetched_at }
  }
  if (!entry.fetched_at) {
    throw new Error(
      `fixtures/manifest.json entry ${sourceId} has neither fetched_at nor constructed`,
    )
  }
  return { source_url: entry.source_url, fetched_at: entry.fetched_at }
}
