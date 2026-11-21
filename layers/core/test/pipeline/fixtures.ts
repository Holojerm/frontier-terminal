// Committed fixtures, by repo-relative path — the same strings parsers register as
// fixturePath / sideFixturePaths, so the determinism harness resolves a registration
// straight to its bytes. workerd has no filesystem, so vitest.config.ts reads every file
// under fixtures/ (plus sources.yaml) in Node and serves them from the FIXTURES service
// binding, fetched once when this module loads. Do not turn these back into `?raw` imports
// (each test file would transform and evaluate ~13 MB of strings) or a plain binding (every
// file's worker would copy them at spawn, whether it reads them or not).

import { env } from 'cloudflare:test'

import manifestJson from '~~/fixtures/manifest.json'

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

/** The RawStore a refresh test hands runRefresh: payloads land in this file's R2 binding. */
export const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}

/** Serves the committed fixtures by URL. An override replaces a source's bytes, or its
 * whole outcome, by source id. A URL with no fixture throws, unless `missing` is given. */
export function fixtureFetcher(
  overrides: Record<string, string | FetchOutcome> = {},
  missing?: FetchOutcome,
): SourceFetcher {
  const byUrl = new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))
  return async (source) => {
    const override = overrides[source.source_id]
    if (override !== undefined && typeof override !== 'string') return override
    const text = override ?? byUrl.get(source.url)
    if (text === undefined) {
      if (missing) return missing
      throw new Error(`no fixture for ${source.url}`)
    }
    return { ok: true, status: 200, text, bytes: text.length }
  }
}

/** The committed xAI job board with one job taken down. */
export function xaiJobsWithout(id: number): string {
  const board = JSON.parse(fixtureText('fixtures/hiring/xai-greenhouse.json')) as {
    jobs: { id: number }[]
  }
  return JSON.stringify({ ...board, jobs: board.jobs.filter((j) => j.id !== id) })
}
