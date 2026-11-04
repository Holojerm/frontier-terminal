// What the UI knows about each source beyond its rows: a label, a role, and
// the caveat the audit attached to it.
//
// Caveats are READ from sources.yaml, never retyped here. That file
// transcribes docs/source-audit.md, and a caveat the UI paraphrased would be
// a third copy that drifts from the other two. The only hand-kept part is
// the label/role map below, and layers/terminal/test/terminal-sources.test.ts fails when
// sources.yaml gains an include source this map has no entry for.
//
// Pure functions of the YAML text, so the same code runs in the Worker (with
// a `raw:` import) and in the workerd suite (with a `?raw` import). The
// reader is deliberately narrow — the same shape layers/terminal/server/pipeline/sources.ts
// uses — because a YAML dependency for one flat file is not worth carrying.

import {
  SOURCE_RIGHTS,
  type LabId,
  type ProviderId,
  type SourceAxis,
  type SourceRights,
  type SourceRole,
} from '../../shared/utils/terminal-types'

export interface SourceLabel {
  label: string
  role: SourceRole
}

/** Human labels and roles per source id. Everything else comes from sources.yaml. */
export const SOURCE_LABELS: Readonly<Record<string, SourceLabel>> = {
  'openai-models-md': { label: 'OpenAI models.md', role: 'primary' },
  'openai-pricing-md': { label: 'OpenAI pricing.md', role: 'primary' },
  'anthropic-models-md': { label: 'Anthropic models overview.md', role: 'primary' },
  'anthropic-pricing-md': { label: 'Anthropic pricing.md', role: 'primary' },
  'xai-models-md': { label: 'xAI models.md', role: 'primary' },
  'meta-models-md': { label: 'Meta models.md', role: 'primary' },
  'meta-pricing-md': { label: 'Meta pricing and rate limits.md', role: 'primary' },
  'mistral-models-md': { label: 'Mistral models.md', role: 'primary' },
  'mistral-pricing-md': { label: 'Mistral API pricing.md', role: 'primary' },
  'deepseek-pricing-md': { label: 'DeepSeek models and pricing.md', role: 'primary' },
  'alibaba-pricing-html': {
    label: 'Alibaba Cloud Model Studio pricing (Singapore, international)',
    role: 'primary',
  },
  'alibaba-models-html': {
    label: 'Alibaba Cloud Model Studio recommended models',
    role: 'primary',
  },
  'moonshot-models-md': { label: 'Moonshot AI (Kimi) model list.md', role: 'primary' },
  'google-pricing-html': { label: 'Google Gemini API pricing', role: 'primary' },
  'google-models-md': { label: 'Google Gemini API models.md', role: 'primary' },
  'openrouter-models': { label: 'OpenRouter /api/v1/models', role: 'cross-check' },
  'openrouter-rankings-daily': { label: 'OpenRouter usage rankings (daily)', role: 'primary' },
  'openai-ashby': { label: 'OpenAI Ashby job board', role: 'primary' },
  'mistral-ashby': { label: 'Mistral Ashby job board', role: 'primary' },
  'google-careers': { label: 'Google careers feed (DeepMind roles only)', role: 'primary' },
  'anthropic-greenhouse': { label: 'Anthropic Greenhouse jobs', role: 'primary' },
  'anthropic-greenhouse-departments': {
    label: 'Anthropic Greenhouse departments',
    role: 'join',
  },
  'xai-greenhouse': { label: 'xAI Greenhouse jobs', role: 'primary' },
  'xai-greenhouse-departments': { label: 'xAI Greenhouse departments', role: 'join' },
  'edgar-fts': { label: 'EDGAR full-text search for S-1s (“Anthropic”)', role: 'sec' },
  'edgar-fts-openai': { label: 'EDGAR full-text search for S-1s (“OpenAI”)', role: 'sec' },
  'edgar-submissions-spcx': { label: 'EDGAR submissions (SPCX, xAI’s parent)', role: 'sec' },
  'edgar-submissions-msft': { label: 'EDGAR submissions (MSFT)', role: 'sec' },
  'edgar-submissions-amzn': { label: 'EDGAR submissions (AMZN)', role: 'sec' },
  'edgar-submissions-nvda': { label: 'EDGAR submissions (NVDA)', role: 'sec' },
  'edgar-submissions-googl': { label: 'EDGAR submissions (GOOGL)', role: 'sec' },
  'edgar-submissions-meta': { label: 'EDGAR submissions (META)', role: 'sec' },
  'edgar-submissions-orcl': { label: 'EDGAR submissions (ORCL)', role: 'sec' },
  'edgar-submissions-baba': { label: 'EDGAR submissions (BABA, Qwen’s parent)', role: 'sec' },
  'edgar-companyfacts-spcx': {
    label: 'EDGAR XBRL company facts (SPCX, xAI’s parent)',
    role: 'sec',
  },
  'openai-status': { label: 'OpenAI status page incidents', role: 'status' },
  'anthropic-status': { label: 'Anthropic (Claude) status page incidents', role: 'status' },
  'google-cloud-status': {
    label: 'Google Cloud status incidents (Gemini / Vertex AI only)',
    role: 'status',
  },
  'mistral-status': { label: 'Mistral status page incidents', role: 'status' },
  'deepseek-status': { label: 'DeepSeek status page incident history (RSS)', role: 'status' },
  'deepseek-status-atom': {
    label: 'DeepSeek status page incident history (Atom, for end times)',
    role: 'join',
  },
  'xai-status': { label: 'xAI status page incident history (RSS)', role: 'status' },
  'openai-misalignment-reports': {
    label: 'OpenAI misalignment reports and notices',
    role: 'primary',
  },
}

export const PROVIDER_DISPLAY: Readonly<Record<ProviderId, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  meta: 'Meta',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  alibaba: 'Alibaba',
  moonshot: 'Moonshot AI',
  other: 'Other',
}

/** The tracked labs, in the order every panel lists them. */
export const PROVIDER_ORDER = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'meta',
  'mistral',
  'deepseek',
  'alibaba',
  'moonshot',
] as const

// Each per-axis map below names, for every lab, either the feed that backs
// it or the sources.yaml cut that says why none does. A lab with no feed
// reads as the audit's reason and never as a zero.

/** Which hiring feeds back each lab: the board first, then its join. */
export const HIRING_SOURCES: Readonly<
  Record<LabId, { source_ids: string[] } | { cut_id: string }>
> = {
  openai: { source_ids: ['openai-ashby'] },
  anthropic: { source_ids: ['anthropic-greenhouse', 'anthropic-greenhouse-departments'] },
  google: { source_ids: ['google-careers'] },
  xai: { source_ids: ['xai-greenhouse', 'xai-greenhouse-departments'] },
  meta: { cut_id: 'meta-hiring' },
  mistral: { source_ids: ['mistral-ashby'] },
  deepseek: { cut_id: 'deepseek-hiring' },
  alibaba: { cut_id: 'alibaba-hiring' },
  moonshot: { cut_id: 'moonshot-hiring' },
}

/** Which status feed backs each lab. */
export const INCIDENT_SOURCES: Readonly<Record<LabId, { source_id: string } | { cut_id: string }>> =
  {
    openai: { source_id: 'openai-status' },
    anthropic: { source_id: 'anthropic-status' },
    google: { source_id: 'google-cloud-status' },
    xai: { source_id: 'xai-status' },
    meta: { cut_id: 'meta-status' },
    mistral: { source_id: 'mistral-status' },
    deepseek: { source_id: 'deepseek-status' },
    alibaba: { cut_id: 'alibaba-status' },
    moonshot: { cut_id: 'moonshot-status' },
  }

/** Which disclosure index backs each lab. */
export const DISCLOSURE_SOURCES: Readonly<
  Record<LabId, { source_id: string } | { cut_id: string }>
> = {
  openai: { source_id: 'openai-misalignment-reports' },
  anthropic: { cut_id: 'anthropic-disclosures' },
  google: { cut_id: 'google-disclosures' },
  xai: { cut_id: 'xai-disclosures' },
  meta: { cut_id: 'meta-disclosures' },
  mistral: { cut_id: 'mistral-disclosures' },
  deepseek: { cut_id: 'deepseek-disclosures' },
  alibaba: { cut_id: 'alibaba-disclosures' },
  moonshot: { cut_id: 'moonshot-disclosures' },
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
  /** Data license, where the source states one (the rankings feed: CC BY 4.0). */
  license: string | null
  /** Required citation template; `{meta.as_of}` is filled by the query that serves it. */
  citation: string | null
  /** The audit's terms and robots.txt reading; what is taken and how often. */
  terms: string | null
  rights: SourceRights | null
}

export interface CutSourceEntry {
  id: string
  verdict: string
  reason: string
}

/** A thesis recipe's audit entry (sources.yaml `recipe_sources`). */
export interface RecipeSourceEntry {
  recipe_id: string
  url: string | null
  verdict: string
  terms: string | null
  rights: SourceRights | null
  caveat: string | null
}

/** A source the track record queries per alert (sources.yaml `track_record_sources`). */
export interface TrackRecordSourceEntry {
  id: string
  url: string | null
  verdict: string
  terms: string | null
  rights: SourceRights | null
  caveat: string | null
}

export interface SourceRegistry {
  sources: RegisteredSource[]
  cuts: CutSourceEntry[]
  recipes: RecipeSourceEntry[]
  track_record: TrackRecordSourceEntry[]
}

// sources.yaml keys whose fixture id (the id every table row carries) is spelt
// differently. Joined on the fixture path in layers/terminal/server/pipeline/sources.ts; here
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
 * Parse one top-level block (`sources:`, `cut:`, `recipe_sources:`) into its entries. Handles
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

const AXES: readonly SourceAxis[] = [
  'pricing-catalog',
  'pricing-cross-check',
  'hiring',
  'sec',
  'revenue',
  'status',
  'disclosures',
  'demand-share',
]
const PROVIDERS: readonly (ProviderId | 'all')[] = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'meta',
  'mistral',
  'deepseek',
  'alibaba',
  'moonshot',
  'other',
  'all',
]

function rightsOf(id: string, value: string | null | undefined): SourceRights | null {
  if (value == null) return null
  if (!(SOURCE_RIGHTS as readonly string[]).includes(value)) {
    throw new Error(`sources.yaml ${id}: unknown rights ${value}`)
  }
  return value as SourceRights
}

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
      license: block.fields.license ?? null,
      citation: block.fields.citation ?? null,
      terms: block.fields.terms ?? null,
      rights: rightsOf(block.id, block.fields.rights),
    })
  }
  if (sources.length === 0) throw new Error('sources.yaml yielded zero include sources')

  const cuts: CutSourceEntry[] = readBlock(lines, 'cut').map((block) => ({
    id: block.id,
    verdict: block.fields.verdict ?? 'cut',
    reason: block.fields.reason ?? '',
  }))

  const recipes: RecipeSourceEntry[] = readBlock(lines, 'recipe_sources').map((block) => ({
    recipe_id: block.id,
    url: block.fields.url ?? null,
    verdict: block.fields.verdict ?? '',
    terms: block.fields.terms ?? null,
    rights: rightsOf(block.id, block.fields.rights),
    caveat: block.fields.caveats ?? null,
  }))

  const track_record: TrackRecordSourceEntry[] = readBlock(lines, 'track_record_sources').map(
    (block) => ({
      id: block.id,
      url: block.fields.url ?? null,
      verdict: block.fields.verdict ?? '',
      terms: block.fields.terms ?? null,
      rights: rightsOf(block.id, block.fields.rights),
      caveat: block.fields.caveats ?? null,
    }),
  )

  return { sources, cuts, recipes, track_record }
}

/** Derived source ids (layers/terminal/server/pipeline/derived.ts) are named by their template. */
/** `anthropic-s-1-a-…` -> `S-1/A`: the form slug a registration key carries (parsers/sec/filing-index.ts). */
const registrationForm = (key: string) =>
  (key.match(/^[a-z]+-(s-1-a|s-1|424b4)-/)?.[1] ?? '').toUpperCase().replace(/-A$/, '/A')

const DERIVED_LABELS: readonly {
  prefix: string
  label: (key: string) => string
  role: SourceRole
}[] = [
  {
    prefix: 'edgar-submissions-',
    label: (k) => `EDGAR submissions (${k}, resolved filer)`,
    role: 'sec',
  },
  {
    prefix: 'xbrl-segment-',
    label: (k) =>
      `EDGAR XBRL segment facts (${k.split('-')[0]!.toUpperCase()} filing ${k.slice(-20)})`,
    role: 'sec',
  },
  {
    prefix: 'filing-index-',
    label: (k) => `EDGAR filing index (${k.split('-')[0]} ${registrationForm(k)}, ${k.slice(-20)})`,
    role: 'sec',
  },
  {
    prefix: 'prospectus-revenue-',
    label: (k) =>
      `${registrationForm(k)} statement of operations (${k.split('-')[0]}, ${k.slice(-20)})`,
    role: 'sec',
  },
  {
    prefix: 'edgar-companyfacts-',
    label: (k) => `EDGAR XBRL company facts (${k}, resolved filer)`,
    role: 'sec',
  },
  { prefix: 'openai-model-md-', label: (k) => `OpenAI model page (${k})`, role: 'primary' },
  { prefix: 'google-model-md-', label: (k) => `Google model page (${k})`, role: 'primary' },
  {
    prefix: 'openai-misalignment-report-',
    label: (k) => `OpenAI misalignment report page (${k})`,
    role: 'primary',
  },
]

/**
 * The registered source whose terms a derived template's fetches fall under:
 * the same host, read under the same terms (sources.yaml derived_sources).
 */
export const DERIVED_TERMS_FROM: Readonly<Record<string, string>> = {
  'edgar-submissions': 'edgar-submissions',
  'edgar-companyfacts': 'edgar-companyfacts-spcx',
  'xbrl-segment': 'edgar-submissions',
  'filing-index': 'edgar-submissions',
  'prospectus-revenue': 'edgar-submissions',
  'openai-model-md': 'openai-models-md',
  'google-model-md': 'google-models-md',
  'openai-misalignment-report': 'openai-misalignment-reports',
}

/** The template a derived source id came from, or null for a registered one. */
export function derivedTemplateOf(sourceId: string): string | null {
  if (SOURCE_LABELS[sourceId]) return null
  const d = DERIVED_LABELS.find((x) => sourceId.startsWith(x.prefix))
  return d ? d.prefix.slice(0, -1) : null
}

/** The label for a source id: registered, derived by template, or the id itself so an unlabeled source is still named. */
export function labelOf(sourceId: string): SourceLabel {
  const known = SOURCE_LABELS[sourceId]
  if (known) return known
  const d = DERIVED_LABELS.find((x) => sourceId.startsWith(x.prefix))
  if (d) return { label: d.label(sourceId.slice(d.prefix.length)), role: d.role }
  return { label: sourceId, role: 'primary' }
}

/** A hyperscaler filer whose XBRL facts the exposure series read (sources.yaml `filed_fact_sources`). */
export interface FiledFactSourceEntry {
  id: string
  ticker: string
  /** Company facts: every non-dimensional fact, with its accession. */
  url: string
  /** True when each 10-Q/10-K's own instance is read for the dimensional facts. */
  instances: boolean
  terms: string | null
  rights: SourceRights | null
  caveat: string | null
}

/** The `filed_fact_sources` block. Each url must name the CIK cik_whitelist holds for its ticker. */
export function readFiledFactSources(
  sourcesYaml: string,
  whitelist: ReadonlyMap<string, string | null>,
): (FiledFactSourceEntry & { cik: string })[] {
  return readBlock(sourcesYaml.split('\n'), 'filed_fact_sources').map((block) => {
    const ticker = block.fields.ticker
    const url = block.fields.url
    if (!ticker || !url) throw new Error(`sources.yaml ${block.id}: needs ticker and url`)
    const cik = whitelist.get(ticker)
    if (!cik) throw new Error(`sources.yaml ${block.id}: ${ticker} is not in cik_whitelist`)
    if (url !== `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`) {
      throw new Error(`sources.yaml ${block.id}: url does not name CIK ${cik}`)
    }
    return {
      id: block.id,
      ticker,
      cik,
      url,
      instances: block.fields.instances === 'true',
      terms: block.fields.terms ?? null,
      rights: rightsOf(block.id, block.fields.rights),
      caveat: block.fields.caveats ?? null,
    }
  })
}
