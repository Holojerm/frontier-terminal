// What the UI knows about each source beyond its rows: a label, a role, and
// the caveat the audit attached to it.
//
// Caveats are READ from sources.yaml, never retyped here. That file
// transcribes docs/source-audit.md, and a caveat the UI paraphrased would be
// a third copy that drifts from the other two. The only hand-kept part is
// the label/role map below, and test/terminal-sources.test.ts fails when
// sources.yaml gains an include source this map has no entry for.
//
// Pure functions of the YAML text, so the same code runs in the Worker (with
// a `raw:` import) and in the workerd suite (with a `?raw` import). The
// reader is deliberately narrow — the same shape server/pipeline/sources.ts
// uses — because a YAML dependency for one flat file is not worth carrying.

import type { ProviderId, SourceAxis, SourceRole } from '#shared/utils/terminal-types'

export interface SourceLabel {
  label: string
  role: SourceRole
}

/** Human labels and roles per source id. Everything else comes from sources.yaml. */
export const SOURCE_LABELS: Readonly<Record<string, SourceLabel>> = {
  'openai-models-md': { label: 'OpenAI models.md', role: 'primary' },
  'anthropic-models-md': { label: 'Anthropic models overview.md', role: 'primary' },
  'anthropic-pricing-md': { label: 'Anthropic pricing.md', role: 'primary' },
  'xai-models-md': { label: 'xAI models.md', role: 'primary' },
  'google-pricing-html': { label: 'Google Gemini API pricing', role: 'primary' },
  'openrouter-models': { label: 'OpenRouter /api/v1/models', role: 'cross-check' },
  'openai-ashby': { label: 'OpenAI Ashby job board', role: 'primary' },
  'anthropic-greenhouse': { label: 'Anthropic Greenhouse jobs', role: 'primary' },
  'anthropic-greenhouse-departments': {
    label: 'Anthropic Greenhouse departments (join)',
    role: 'join',
  },
  'xai-greenhouse': { label: 'xAI Greenhouse jobs', role: 'primary' },
  'xai-greenhouse-departments': { label: 'xAI Greenhouse departments (join)', role: 'join' },
  'edgar-fts': { label: 'EDGAR full-text search (S-1 tripwire)', role: 'sec' },
  'edgar-submissions-spcx': { label: 'EDGAR submissions (SPCX)', role: 'sec' },
}

export const PROVIDER_DISPLAY: Readonly<Record<ProviderId, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  other: 'Other',
}

/** The big four, in the order every panel lists them. */
export const PROVIDER_ORDER = ['openai', 'anthropic', 'google', 'xai'] as const

/** Which hiring feeds back each provider — for provenance before rows land. */
export const HIRING_SOURCE_IDS: Readonly<Record<'openai' | 'anthropic' | 'xai', string[]>> = {
  openai: ['openai-ashby'],
  anthropic: ['anthropic-greenhouse', 'anthropic-greenhouse-departments'],
  xai: ['xai-greenhouse', 'xai-greenhouse-departments'],
}

export interface RegisteredSource {
  /** The key in sources.yaml. The manifest source_id differs for one entry
   * (`edgar-submissions` -> `edgar-submissions-spcx`); `sourceIdOf` maps it. */
  yaml_id: string
  source_id: string
  axis: SourceAxis
  provider: ProviderId | 'all'
  url: string
  verdict: string
  caveat: string | null
}

export interface CutSourceEntry {
  id: string
  verdict: string
  reason: string
}

export interface SourceRegistry {
  sources: RegisteredSource[]
  cuts: CutSourceEntry[]
}

// sources.yaml keys whose fixture id (the id every table row carries) is spelt
// differently. Joined on the fixture path in server/pipeline/sources.ts; here
// the fixture filename is enough to recover it.
function sourceIdOf(yamlId: string, fixture: string | null): string {
  const stem = fixture?.match(/\/([^/]+)\.[^./]+$/)?.[1]
  if (yamlId === 'edgar-submissions' && stem) return stem
  return yamlId
}

interface Block {
  id: string
  fields: Record<string, string | null>
}

/**
 * Parse one top-level block (`sources:` or `cut:`) into its entries. Handles
 * the three value shapes the file uses: a scalar on the key's line, `null`,
 * and a `>-` folded block whose continuation lines are indented deeper than
 * the key. Folding joins lines with one space, which is what YAML does for
 * `>-` when there are no blank lines — and the file has none inside a caveat.
 */
function readBlock(lines: string[], name: string): Block[] {
  const start = lines.findIndex((l) => new RegExp(`^${name}:\\s*(#.*)?$`).test(l))
  if (start === -1) return []

  const blocks: Block[] = []
  let current: Block | null = null
  let folding: { key: string; parts: string[] } | null = null

  const flush = () => {
    if (current && folding) {
      current.fields[folding.key] = folding.parts.join(' ').trim() || null
    }
    folding = null
  }

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\S/.test(line)) break // next top-level key ends the block
    if (/^\s*(#.*)?$/.test(line)) continue

    const idMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/)
    if (idMatch) {
      flush()
      current = { id: idMatch[1]!, fields: {} }
      blocks.push(current)
      continue
    }
    if (!current) continue

    const kv = line.match(/^ {4}([A-Za-z_]+):\s*(.*?)\s*$/)
    if (kv) {
      flush()
      const key = kv[1]!
      const raw = kv[2]!.replace(/\s+#.*$/, '')
      if (raw === '>-' || raw === '>') {
        folding = { key, parts: [] }
      } else {
        current.fields[key] = raw === 'null' || raw === '' ? null : raw.replace(/^"(.*)"$/, '$1')
      }
      continue
    }
    if (folding && /^ {6,}\S/.test(line)) folding.parts.push(line.trim())
  }
  flush()
  return blocks
}

const AXES: readonly SourceAxis[] = ['pricing-catalog', 'pricing-cross-check', 'hiring', 'sec']
const PROVIDERS: readonly (ProviderId | 'all')[] = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'other',
  'all',
]

/** Every include source and every deliberate cut, as sources.yaml states them. */
export function readSourceRegistry(sourcesYaml: string): SourceRegistry {
  const lines = sourcesYaml.split('\n')

  const sources: RegisteredSource[] = []
  for (const block of readBlock(lines, 'sources')) {
    const verdict = block.fields.verdict ?? ''
    if (!verdict.startsWith('include')) continue
    const axis = block.fields.axis
    const provider = block.fields.provider
    const url = block.fields.url
    if (!axis || !AXES.includes(axis as SourceAxis)) {
      throw new Error(`sources.yaml ${block.id}: unknown axis ${axis}`)
    }
    if (!provider || !PROVIDERS.includes(provider as ProviderId | 'all')) {
      throw new Error(`sources.yaml ${block.id}: unknown provider ${provider}`)
    }
    if (!url) throw new Error(`sources.yaml ${block.id}: no url`)
    sources.push({
      yaml_id: block.id,
      source_id: sourceIdOf(block.id, block.fields.fixture ?? null),
      axis: axis as SourceAxis,
      provider: provider as ProviderId | 'all',
      url,
      verdict,
      caveat: block.fields.caveats ?? null,
    })
  }
  if (sources.length === 0) throw new Error('sources.yaml yielded zero include sources')

  const cuts: CutSourceEntry[] = readBlock(lines, 'cut').map((block) => ({
    id: block.id,
    verdict: block.fields.verdict ?? 'cut',
    reason: block.fields.reason ?? '',
  }))

  return { sources, cuts }
}

/** The label for a source id, or the id itself so an unlabeled source is still named. */
export function labelOf(sourceId: string): SourceLabel {
  return SOURCE_LABELS[sourceId] ?? { label: sourceId, role: 'primary' }
}
