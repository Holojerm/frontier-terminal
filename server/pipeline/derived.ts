import { and, desc, eq, inArray, like, sql } from 'drizzle-orm'

import * as tables from '../db/schema'
import type { Provider } from './contracts'
import { parseRevenueFilersBlock } from './parsers/sec/revenue-filers'
import { parseCikWhitelistBlock } from './parsers/sec/whitelist'
import { periodBefore, segmentKey } from './parsers/sec/xbrl-segment'
import type { FetchSource } from './sources'
import type { PipelineDb } from './store'

// Sources the store derives for itself: a URL template audited in
// sources.yaml (`derived_sources`) filled with a key the store already holds.
// Five keys exist — a lab's CIK from its `filer` row, a priced OpenAI model
// slug from openai-pricing-md, a priced Google model slug from
// google-pricing-html, a report slug from the misalignment index
// (openai-misalignment-reports), and a segment filer's recent 10-Q/10-K from
// its submissions feed — and none is ever typed into code.
// A derived source is polled, snapshotted, parsed and diffed exactly like a
// registered one; its lane is matched by id prefix (lanes.ts › laneFor).

const DERIVED_FROM = [
  'filer',
  'openai-priced-model',
  'google-priced-model',
  'openai-misalignment-report',
  'segment-filing',
] as const
type DerivedFrom = (typeof DERIVED_FROM)[number]

export interface DerivedTemplate {
  id: string
  url: string
  from: DerivedFrom
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
    if (!(DERIVED_FROM as readonly string[]).includes(current.from)) {
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

/** Priced slugs on one pricing page's Standard tier, sorted. OpenAI's Standard rows carry tier null; Google's say "standard". */
async function pricedSlugs(
  db: PipelineDb,
  sourceId: string,
  provider: Provider,
  standardTier: string | null,
): Promise<string[]> {
  const slug = sql<string | null>`json_extract(${tables.entities.payload}, '$.model_slug')`
  const tier = sql<string | null>`json_extract(${tables.entities.payload}, '$.tier')`
  const input = sql<number | null>`json_extract(${tables.entities.payload}, '$.input_per_mtok')`
  const rows = await db
    .select({ slug })
    .from(tables.entities)
    .where(
      and(
        eq(tables.entities.source_id, sourceId),
        eq(tables.entities.entity_type, 'model'),
        standardTier === null ? sql`${tier} IS NULL` : sql`${tier} = ${standardTier}`,
        sql`${input} IS NOT NULL`,
        like(tables.entities.entity_key, `model:${provider}:%`),
      ),
    )
  return [
    ...new Set(rows.map((r) => r.slug).filter((s): s is string => !!s && /^[a-z0-9.-]+$/.test(s))),
  ].sort()
}

/** Priced Standard-tier slugs on the OpenAI pricing page, sorted. */
export const openAiPricedSlugs = (db: PipelineDb) =>
  pricedSlugs(db, 'openai-pricing-md', 'openai', null)

/** Priced Standard-tier slugs on the Google pricing page, sorted. */
export const googlePricedSlugs = (db: PipelineDb) =>
  pricedSlugs(db, 'google-pricing-html', 'google', 'standard')

/** Report slugs on the OpenAI misalignment index, sorted. Notices link off-site and are not derived. */
export async function openAiMisalignmentReportSlugs(db: PipelineDb): Promise<string[]> {
  const kind = sql<string | null>`json_extract(${tables.entities.payload}, '$.kind')`
  const id = sql<string | null>`json_extract(${tables.entities.payload}, '$.entry_id')`
  const rows = await db
    .select({ id })
    .from(tables.entities)
    .where(
      and(
        eq(tables.entities.source_id, 'openai-misalignment-reports'),
        eq(tables.entities.entity_type, 'disclosure'),
        sql`${kind} = 'report'`,
      ),
    )
  return [
    ...new Set(
      rows.map((r) => r.id).filter((s): s is string => !!s && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)),
    ),
  ].sort()
}

/** Periodic filings a segment source is derived for, per filer: one fiscal year's worth. */
export const SEGMENT_FILINGS_PER_FILER = 4

export interface SegmentFiling {
  ticker: string
  cik: string
  segment: string
  accession_no: string
  file_date: string
}

/**
 * The newest 10-Q/10-K per segment filer (sources.yaml revenue_filers with a
 * `segment`), read from the filings its submissions feed stored. Amendments
 * are left out: the instance-name rule (sources.yaml › xbrl-segment) is
 * verified on originals only.
 */
export async function segmentFilings(
  db: PipelineDb,
  sourcesYaml: string,
): Promise<SegmentFiling[]> {
  const whitelist = parseCikWhitelistBlock(sourcesYaml)
  const out: SegmentFiling[] = []
  for (const filer of parseRevenueFilersBlock(sourcesYaml).values()) {
    const cik = filer?.segment ? whitelist.get(filer.ticker) : null
    if (!filer?.segment || !cik) continue
    const form = sql<string | null>`json_extract(${tables.entities.payload}, '$.form')`
    const fileDate = sql<string | null>`json_extract(${tables.entities.payload}, '$.file_date')`
    const accession = sql<string | null>`json_extract(${tables.entities.payload}, '$.accession_no')`
    const rows = await db
      .select({ accession, fileDate })
      .from(tables.entities)
      .where(
        and(
          eq(tables.entities.source_id, `edgar-submissions-${filer.ticker.toLowerCase()}`),
          eq(tables.entities.entity_type, 'filing'),
          inArray(form, ['10-Q', '10-K']),
        ),
      )
      .orderBy(desc(fileDate), desc(accession))
      .limit(SEGMENT_FILINGS_PER_FILER)
    for (const r of rows) {
      if (!r.accession || !/^\d{10}-\d{2}-\d{6}$/.test(r.accession)) continue
      if (!r.fileDate || !/^\d{4}-\d{2}-\d{2}$/.test(r.fileDate)) continue
      out.push({
        ticker: filer.ticker,
        cik,
        segment: filer.segment,
        accession_no: r.accession,
        file_date: r.fileDate,
      })
    }
  }
  return out
}

export const derivedSourceId = (template: string, key: string) => `${template}-${key}`

/** Every derived source the store can name right now, in a stable order. */
export async function deriveSources(db: PipelineDb, sourcesYaml: string): Promise<FetchSource[]> {
  const templates = parseDerivedSourcesBlock(sourcesYaml)
  const [filers, slugs, googleSlugs, reports, segments] = await Promise.all([
    resolvedFilers(db),
    openAiPricedSlugs(db),
    googlePricedSlugs(db),
    openAiMisalignmentReportSlugs(db),
    segmentFilings(db, sourcesYaml),
  ])
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
    } else if (t.from === 'segment-filing') {
      for (const f of segments) {
        out.push({
          source_id: derivedSourceId(t.id, segmentKey(f.ticker, f.file_date, f.accession_no)),
          url: t.url
            .replace('{cik_number}', String(Number(f.cik)))
            .replace('{accession_digits}', f.accession_no.replace(/-/g, ''))
            .replace('{prefix}', f.segment.split(':')[0]!)
            .replace('{period}', periodBefore(f.file_date).replace(/-/g, '')),
          ext: 'xml',
        })
      }
    } else if (t.from === 'openai-misalignment-report') {
      for (const slug of reports) {
        out.push({
          source_id: derivedSourceId(t.id, slug),
          url: t.url.replace('{slug}', slug),
          ext: 'html',
        })
      }
    } else if (t.from === 'google-priced-model') {
      for (const slug of googleSlugs) {
        out.push({
          source_id: derivedSourceId(t.id, slug),
          url: t.url.replace('{slug}', slug),
          ext: 'md',
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
