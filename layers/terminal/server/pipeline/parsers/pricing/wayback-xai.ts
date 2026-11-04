import { VendorMdPricingOutput, modelKey, type PriceRow, type Provenance } from '../../contracts'
import { htmlSections, htmlText, stripInvisible, usdPerMillion } from './html-table'
import { tableAfterHeading } from './md-table'
import { parseXaiModelsMd } from './xai-models'

// xAI's own pages as the Internet Archive captured them (archive/eras.ts
// names each era's URL and window):
//
//   2025-03 to 2025-07, x.ai/api: one card per model with "Text Input",
//   "Image Input" and "Completion"/"Output" prices per million tokens.
//   2025-07 to 2026-02, docs.x.ai/docs/models: a "Model Pricing" table, when
//   the capture holds it rendered (many hold only "Loading models...").
//   2026-03 onward, docs.x.ai/developers/models.md: a markdown table, in three
//   successive layouts, the last of them the one the live parser reads.
//
// The tier. The live page prints each model twice, "(< 200k prompt tokens)"
// as tier `standard` and "(≥ 200k prompt tokens)" as `long_context`. Every
// archived layout before it prints one price per model, the base price, so
// it is filed under `standard`, the live key for that price, and the row
// says the page printed a single price. Model ids are kept exactly as each
// page printed them (grok-4.20-beta-0309-reasoning stays as printed).

function base(slug: string, prov: Provenance): PriceRow {
  return {
    provider: 'xai',
    model_slug: slug,
    tier: 'standard',
    context_window: null,
    input_per_mtok: null,
    cached_input_per_mtok: null,
    output_per_mtok: null,
    currency: 'USD',
    effective_from: null,
    effective_until: null,
    notes: null,
    ...prov,
  }
}

const SINGLE = 'one price printed per model (the base, short-prompt price)'
const MODEL = /^grok-[a-z0-9][a-z0-9.-]*$/
const keyOf = (r: PriceRow) => modelKey(r.provider, r.model_slug, r.tier)

/** One row per key; a key printed twice must carry the same prices. */
function finish(rows: PriceRow[], what: string, passed: string[] = []) {
  const byKey = new Map<string, PriceRow>()
  for (const r of rows) {
    const held = byKey.get(keyOf(r))
    if (!held) {
      byKey.set(keyOf(r), r)
      continue
    }
    if (
      held.input_per_mtok !== r.input_per_mtok ||
      held.cached_input_per_mtok !== r.cached_input_per_mtok ||
      held.output_per_mtok !== r.output_per_mtok
    ) {
      throw new Error(`${what}: ${r.model_slug} printed twice at different prices`)
    }
  }
  if (byKey.size === 0) throw new Error(`${what}: no token price rows`)
  const out = [...byKey.values()].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))
  return { ...VendorMdPricingOutput.parse({ rows: out }), passed: [...new Set(passed)].sort() }
}

const usd = (cell: string) => usdPerMillion(cell.replace(/,/g, ''), 1_000_000)

// ---- x.ai/api, 2025-03 to 2025-07 ----------------------------------------------

const AMOUNT = String.raw`\$\d[\d,]*(?:\.\d+)?`
const CARD = new RegExp(
  String.raw`(grok-[a-z0-9][a-z0-9.-]*) (?:New )?(?:(?!grok-)[^$])*? (?:Capabilities )?Context(?: window)? [\d,.]+[kKM]? Text Input (${AMOUNT}|-) Image Input (${AMOUNT}|-) (?:Completion|Output) (${AMOUNT}(?: per image)?|-)`,
  'g',
)

/**
 * The model cards of x.ai/api. From mid-2025 the page lists only its
 * featured models and keeps the rest behind "Show older models", which the
 * capture does not hold; read, that would turn every hidden model into a
 * delisting, so such a capture is skipped. A card priced per image, or with
 * no text-input price, is not a token price and is named on the capture.
 */
export function parseXaiApiPage(html: string, prov: Provenance) {
  const text = htmlText(stripInvisible(html))
  if (/Show older models/.test(text)) {
    throw new Error(
      'the page lists featured models only ("Show older models" is not in the capture)',
    )
  }
  if (!/Text Input/.test(text)) throw new Error('the page prints no per-token prices')
  const rows: PriceRow[] = []
  const passed: string[] = []
  for (const m of text.matchAll(CARD)) {
    const [, slug, input, image, output] = m
    if (!MODEL.test(slug!)) throw new Error(`unrecognised model id: ${slug}`)
    if (input === '-' || output === '-' || /per image/.test(output!)) {
      passed.push(`${slug} (not priced per token)`)
      continue
    }
    rows.push({
      ...base(slug!, prov),
      input_per_mtok: usd(input!),
      output_per_mtok: usd(output!),
      notes: [SINGLE, image !== '-' ? `image input ${image}` : null].filter(Boolean).join('; '),
    })
  }
  return finish(rows, 'x.ai/api', passed)
}

// ---- docs.x.ai/docs/models, 2025-07 to 2026-02 -----------------------------------

/**
 * The "Model Pricing" table: group rows ("Language models | | Per million
 * tokens", "Image generation models | | Per image output") between model
 * rows, and a Pricing cell that prints two amounts, input then output. That
 * order is the one x.ai/api printed for the same models at the same time
 * (grok-code-fast-1: $0.20 input, $1.50 output on both). Only rows under
 * "Language models" are read. A model printed once per region
 * ("grok-2-vision-1212 us-east-1") is one row, and the regions must agree.
 */
export function parseXaiDocsModelsHtml(html: string, prov: Provenance) {
  const section = htmlSections(html).find((s) => s.heading === 'Model Pricing')
  if (!section) throw new Error('heading not found: Model Pricing')
  if (section.tables.length !== 1) throw new Error(`Model Pricing: ${section.tables.length} tables`)
  const [header, ...body] = section.tables[0]!
  if (header?.join('|') !== 'Model|Modalities|Capabilities|Context|Rate limits|Pricing') {
    throw new Error(`Model Pricing: columns changed: ${header?.join(' | ')}`)
  }
  if (body.some((r) => /Loading models/.test(r.join(' ')))) {
    throw new Error('Model Pricing: the capture holds the table before its scripts drew it')
  }
  const rows: PriceRow[] = []
  const passed: string[] = []
  let group: string | null = null
  for (const cells of body) {
    if (cells.length === 1 && cells[0] === '') continue
    if (cells.length === 3) {
      group = cells[0]!
      if (group === 'Language models' && cells[2] !== 'Per million tokens') {
        throw new Error(`Language models priced ${cells[2]}`)
      }
      continue
    }
    if (cells.length !== header.length)
      throw new Error(`a row has ${cells.length} cells: ${cells[0]}`)
    const [slug, region] = cells[0]!.split(' ')
    if (!MODEL.test(slug!)) throw new Error(`unrecognised model id: ${cells[0]}`)
    if (group !== 'Language models') {
      passed.push(`${slug} (${group ?? 'ungrouped'})`)
      continue
    }
    const amounts = cells[5]!.split(' ')
    if (amounts.length !== 2)
      throw new Error(`${slug}: pricing cell is not "$in $out": ${cells[5]}`)
    rows.push({
      ...base(slug!, prov),
      input_per_mtok: usd(amounts[0]!),
      output_per_mtok: usd(amounts[1]!),
      notes: [SINGLE, region ? `printed per region; ${region} read` : null]
        .filter(Boolean)
        .join('; '),
    })
  }
  return finish(rows, 'docs.x.ai/docs/models', passed)
}

// ---- docs.x.ai/developers/models.md, 2026-03 onward ------------------------------

/** "$2.00 ($0.20) / $6.00" -> input, cached input, output. */
const IN_CACHED_OUT = /^(\$[\d.]+) \((\$[\d.]+)\) \/ (\$[\d.]+)$/
const PER_UNIT = /^\$[\d.]+ ?\/ ?(?:image|sec)$/

/**
 * The markdown, in the layout of the capture:
 *   March 2026, "# Models and Pricing": Pricing [in (cached in) / out];
 *   June 2026, "### Model Pricing": Input / 1M tokens | Output / 1M tokens;
 *   August 2026, "### Text API Pricing": the live layout, read by the live
 *   parser (xai-models.ts), its `standard` / `long_context` rows unchanged.
 * Models are printed once per cluster (the same row two or three times, with
 * different rate limits); repeats must agree and are one row.
 */
export function parseXaiModelsMdArchived(text: string, prov: Provenance) {
  const has = (h: string) => text.split('\n').some((l) => l.trim() === h)
  if (has('### Text API Pricing')) {
    return { ...parseXaiModelsMd(text, prov), passed: [] as string[] }
  }
  const rows: PriceRow[] = []
  const passed: string[] = []
  // May 2026 kept the "# Models and Pricing" title over the June layout's table.
  if (has('# Models and Pricing') && !has('### Model Pricing')) {
    const [header, ...body] = tableAfterHeading(text, '# Models and Pricing')
    const col = header?.indexOf('Pricing [in (cached in) / out]') ?? -1
    if (header?.[0] !== 'Model' || col === -1) {
      throw new Error(`Models and Pricing: columns changed: ${header?.join(' | ')}`)
    }
    for (const cells of body) {
      const slug = cells[0]!
      if (!MODEL.test(slug)) throw new Error(`unrecognised model id: ${slug}`)
      const cell = cells[col] ?? ''
      if (PER_UNIT.test(cell)) {
        passed.push(`${slug} (not priced per token)`)
        continue
      }
      const m = cell.match(IN_CACHED_OUT)
      if (!m) throw new Error(`${slug}: pricing cell is not "$in ($cached) / $out": ${cell}`)
      rows.push({
        ...base(slug, prov),
        input_per_mtok: usd(m[1]!),
        cached_input_per_mtok: usd(m[2]!),
        output_per_mtok: usd(m[3]!),
        notes: SINGLE,
      })
    }
    return finish(rows, 'docs.x.ai/developers/models.md', passed)
  }
  if (has('### Model Pricing')) {
    const [header, ...body] = tableAfterHeading(text, '### Model Pricing')
    if (header?.join('|') !== 'Model|Context|Input / 1M tokens|Output / 1M tokens') {
      throw new Error(`Model Pricing: columns changed: ${header?.join(' | ')}`)
    }
    for (const cells of body) {
      const slug = cells[0]!
      if (!MODEL.test(slug)) throw new Error(`unrecognised model id: ${slug}`)
      rows.push({
        ...base(slug, prov),
        input_per_mtok: usd(cells[2]!),
        output_per_mtok: usd(cells[3]!),
        notes: SINGLE,
      })
    }
    return finish(rows, 'docs.x.ai/developers/models.md', passed)
  }
  throw new Error('no pricing heading this parser knows')
}
