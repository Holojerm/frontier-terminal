// Committed fixtures, by repo-relative path — the same strings parsers register as
// fixturePath / sideFixturePaths, so the determinism harness resolves a registration
// straight to its bytes. workerd has no filesystem, so vitest.config.ts reads every file
// under fixtures/ (plus sources.yaml) in Node and hands them over as the FIXTURES binding.
// Do not turn these back into `?raw` imports: each test file would then transform and
// evaluate ~10 MB of strings (about 2 s per file).

import { env } from 'cloudflare:test'

import manifestJson from '~~/fixtures/manifest.json'

import { fixtureProvenance } from '../../server/pipeline/parsers/fixture-provenance'

export const manifest = manifestJson

const files: Readonly<Record<string, string>> = env.FIXTURES

/** Text of a committed file by repo-relative path. Throws on an unknown path
 * so a parser registered against a fixture that is not committed fails loudly. */
export function fixtureText(repoRelativePath: string): string {
  const text = files[repoRelativePath]
  if (text === undefined) {
    throw new Error(
      `no fixture at ${repoRelativePath} — commit it under fixtures/ (or sources.yaml)`,
    )
  }
  return text
}

/** Provenance recorded in fixtures/manifest.json for a source id — the tests'
 * expected values come from here, never retyped. For a constructed fixture
 * that is the documentation it was built from (fixture-provenance.ts). */
export function provenanceOf(sourceId: string): { source_url: string; fetched_at: string } {
  return fixtureProvenance(sourceId)
}
