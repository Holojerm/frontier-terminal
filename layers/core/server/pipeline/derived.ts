import type { FetchSource } from '../utils/pipeline-sources'
import type { PipelineDb } from '../utils/pipeline-store'

// Sources the store derives for itself: a URL template audited in
// sources.yaml (`derived_sources`) filled with a key the store already holds.
// Each template names the kind of key it is filled from (`from`), and the
// domain that owns that kind reads its keys and fills the template
// (DerivedKind); server/registries/lanes.ts › DERIVED_SOURCES lists every
// kind. No key is ever typed into code. A derived source is polled,
// snapshotted, parsed and diffed exactly like a registered one; its lane is
// matched by id prefix (server/registries/lanes.ts › laneFor).

export interface DerivedTemplate {
  id: string
  url: string
  /** The DerivedKind whose keys fill the template. */
  from: string
  /** The audit's words about the template, folded, for the coverage panel. */
  caveat: string | null
}

/**
 * One kind of key a template may be filled from. `load` reads the store's keys
 * of that kind once per tick and returns how to fill a template with them.
 */
export interface DerivedKind {
  from: string
  load: (db: PipelineDb, sourcesYaml: string) => Promise<(t: DerivedTemplate) => FetchSource[]>
}

/**
 * Narrow block reader: `  id:` then 4-space `url:` / `from:`; a `>-` field is
 * skipped. A template whose `from` is not one of `kinds` is an error.
 */
export function parseDerivedSourcesBlock(
  yaml: string,
  kinds: readonly string[],
): DerivedTemplate[] {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => /^derived_sources:\s*(#.*)?$/.test(l))
  if (start === -1) throw new Error('sources.yaml has no derived_sources block')
  const out: DerivedTemplate[] = []
  let current: Partial<DerivedTemplate> | null = null
  let folding: string[] | null = null
  const flush = () => {
    if (!current) return
    if (folding) current.caveat = folding.join(' ').trim() || null
    folding = null
    if (!current.url || !current.from)
      throw new Error(`derived_sources ${current.id}: needs url and from`)
    if (!kinds.includes(current.from)) {
      throw new Error(`derived_sources ${current.id}: unknown from ${current.from}`)
    }
    out.push({ caveat: null, ...current } as DerivedTemplate)
    current = null
  }
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(#.*)?$/.test(line)) continue
    if (!/^\s/.test(line)) break
    const head = line.match(/^ {2}([a-z0-9-]+):\s*(#.*)?$/)
    if (head) {
      flush()
      current = { id: head[1]! }
      continue
    }
    const field = line.match(/^ {4}([a-z]+):\s*(.*?)\s*$/)
    if (field && current) {
      const value = field[2]!.replace(/\s+#.*$/, '')
      folding = field[1] === 'caveats' && (value === '>-' || value === '>') ? [] : null
      if (field[1] === 'url') current.url = value
      else if (field[1] === 'from') current.from = value
      continue
    }
    if (folding && /^ {6,}\S/.test(line)) {
      folding.push(line.trim())
      continue
    }
    throw new Error(
      `derived_sources line ${i + 1} is not a template field: ${JSON.stringify(line)}`,
    )
  }
  flush()
  return out
}

export const derivedSourceId = (template: string, key: string) => `${template}-${key}`

/**
 * Every source the templates derive right now, in template order. Every kind
 * reads its keys at once, whether or not a template uses it.
 */
export async function deriveFromTemplates(
  db: PipelineDb,
  sourcesYaml: string,
  kinds: readonly DerivedKind[],
): Promise<FetchSource[]> {
  const templates = parseDerivedSourcesBlock(
    sourcesYaml,
    kinds.map((k) => k.from),
  )
  const fills = await Promise.all(kinds.map((k) => k.load(db, sourcesYaml)))
  const fillOf = new Map(kinds.map((k, i) => [k.from, fills[i]!]))
  return templates.flatMap((t) => fillOf.get(t.from)!(t))
}
