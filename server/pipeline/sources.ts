import type { ManifestFixture } from './parsers/fixture-provenance'

// The source list is never invented in code: sources.yaml carries the
// include verdicts (transcribed from docs/source-audit.md) and
// fixtures/manifest.json records what was actually fetched — e.g. edgar-fts's
// full query string, edgar-submissions' resolved CIK. Pure function of both
// texts so it runs anywhere (Worker, workerd tests) and is trivially
// reproducible.

export interface FetchSource {
  /** Canonical id (manifest source_id — matches snapshot rows). */
  source_id: string
  /** Concrete audited URL, incl. query strings (manifest source_url). */
  url: string
  /** Payload extension for stored raw payloads ("json" | "md" | "html"). */
  ext: string
}

/**
 * Include-verdict sources from sources.yaml, in file order. Narrow reader
 * (same no-YAML-dependency approach as parsers/sec/whitelist.ts): top-level
 * `sources:` block, 2-space-indented ids, 4-space-indented `verdict:` and
 * `fixture:` keys. Each entry is joined to the manifest on the fixture path.
 */
export function includeSources(
  sourcesYaml: string,
  manifest: readonly ManifestFixture[],
): FetchSource[] {
  const lines = sourcesYaml.split('\n')
  const start = lines.findIndex((l) => /^sources:\s*(#.*)?$/.test(l))
  if (start === -1) throw new Error('sources.yaml has no sources block')

  type Entry = { id: string; verdict: string | null; fixture: string | null }
  const entries: Entry[] = []
  let current: Entry | null = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\S/.test(line)) break // next top-level key ends the block
    const idMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/)
    if (idMatch) {
      current = { id: idMatch[1]!, verdict: null, fixture: null }
      entries.push(current)
      continue
    }
    if (!current) continue
    const kv = line.match(/^ {4}(verdict|fixture):\s*(.+?)\s*(#.*)?$/)
    if (kv) {
      if (kv[1] === 'verdict') current.verdict = kv[2]!
      else current.fixture = kv[2]!
    }
  }

  const out: FetchSource[] = []
  for (const e of entries) {
    if (!e.verdict || !e.verdict.startsWith('include')) continue
    if (!e.fixture) throw new Error(`sources.yaml include source ${e.id} has no fixture path`)
    const m = manifest.find((f) => f.path === e.fixture)
    if (!m) {
      throw new Error(`fixtures/manifest.json has no entry for fixture ${e.fixture} (${e.id})`)
    }
    out.push({
      source_id: m.source_id,
      url: m.source_url,
      ext: m.path.match(/\.([^./]+)$/)?.[1] ?? 'raw',
    })
  }
  if (out.length === 0) throw new Error('sources.yaml yielded zero include sources')
  return out
}
