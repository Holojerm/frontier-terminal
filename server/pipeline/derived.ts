import { and, eq, like, sql } from 'drizzle-orm'

import * as tables from '../db/schema'
import type { Provider } from './contracts'
import type { FetchSource } from './sources'
import type { PipelineDb } from './store'

// Sources the store derives for itself: a URL template audited in
// sources.yaml (`derived_sources`) filled with a key the store already holds.
// Two keys exist — a lab's CIK from its `filer` row, and a priced OpenAI
// model slug from openai-pricing-md — and neither is ever typed into code.
// A derived source is polled, snapshotted, parsed and diffed exactly like a
// registered one; its lane is matched by id prefix (lanes.ts › laneFor).

export interface DerivedTemplate {
  id: string
  url: string
  from: 'filer' | 'openai-priced-model'
  /** The audit's words about the template, folded, for the coverage panel. */
  caveat: string | null
}

/** Narrow block reader: `  id:` then 4-space `url:` / `from:`; a `>-` field is skipped. */
export function parseDerivedSourcesBlock(yaml: string): DerivedTemplate[] {
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
    if (current.from !== 'filer' && current.from !== 'openai-priced-model') {
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
      else if (field[1] === 'from') current.from = value as DerivedTemplate['from']
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

export interface ResolvedFiler {
  provider: Provider
  cik: string
  name: string
}

/** The `filer` rows the store holds: which labs resolved, to which CIK. */
export async function resolvedFilers(db: PipelineDb): Promise<ResolvedFiler[]> {
  const rows = await db
    .select({ provider: tables.entities.provider, payload: tables.entities.payload })
    .from(tables.entities)
    .where(eq(tables.entities.entity_type, 'filer'))
  const out: ResolvedFiler[] = []
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload) as { cik?: unknown; name?: unknown }
      if (typeof p.cik === 'string' && /^\d{10}$/.test(p.cik) && typeof p.name === 'string') {
        out.push({ provider: row.provider as Provider, cik: p.cik, name: p.name })
      }
    } catch {
      continue
    }
  }
  return out.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
}

/** Priced Standard-tier slugs on the OpenAI pricing page, sorted. */
export async function openAiPricedSlugs(db: PipelineDb): Promise<string[]> {
  const slug = sql<string | null>`json_extract(${tables.entities.payload}, '$.model_slug')`
  const tier = sql<string | null>`json_extract(${tables.entities.payload}, '$.tier')`
  const input = sql<number | null>`json_extract(${tables.entities.payload}, '$.input_per_mtok')`
  const rows = await db
    .select({ slug })
    .from(tables.entities)
    .where(
      and(
        eq(tables.entities.source_id, 'openai-pricing-md'),
        eq(tables.entities.entity_type, 'model'),
        sql`${tier} IS NULL`,
        sql`${input} IS NOT NULL`,
        like(tables.entities.entity_key, 'model:openai:%'),
      ),
    )
  return [
    ...new Set(rows.map((r) => r.slug).filter((s): s is string => !!s && /^[a-z0-9.-]+$/.test(s))),
  ].sort()
}

export const derivedSourceId = (template: string, key: string) => `${template}-${key}`

/** Every derived source the store can name right now, in a stable order. */
export async function deriveSources(db: PipelineDb, sourcesYaml: string): Promise<FetchSource[]> {
  const templates = parseDerivedSourcesBlock(sourcesYaml)
  const [filers, slugs] = await Promise.all([resolvedFilers(db), openAiPricedSlugs(db)])
  const out: FetchSource[] = []
  for (const t of templates) {
    if (t.from === 'filer') {
      for (const f of filers) {
        out.push({
          source_id: derivedSourceId(t.id, f.provider),
          url: t.url.replace('{cik}', f.cik),
          ext: 'json',
        })
      }
    } else {
      for (const slug of slugs) {
        out.push({
          source_id: derivedSourceId(t.id, slug),
          url: t.url.replace('{slug}', slug),
          ext: 'md',
        })
      }
    }
  }
  return out
}
