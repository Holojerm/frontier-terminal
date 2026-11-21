// Committed fixtures, by repo-relative path — the same strings parsers register as
// fixturePath / sideFixturePaths, so the determinism harness resolves a registration
// straight to its bytes. workerd has no filesystem, so vitest.config.ts reads every file
// under fixtures/ (plus sources.yaml) in Node and serves them from the FIXTURES service
// binding, fetched once when this module loads. Do not turn these back into `?raw` imports
// (each test file would transform and evaluate ~13 MB of strings) or a plain binding (every
// file's worker would copy them at spawn, whether it reads them or not).

import { env } from 'cloudflare:test'

import manifestJson from '~~/fixtures/manifest.json'

import { fixtureProvenance } from '../../server/pipeline/parsers/fixture-provenance'

export const manifest = manifestJson

const files: Readonly<Record<string, string>> = await (
  await env.FIXTURES.fetch('http://fixtures/')
).json()

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
