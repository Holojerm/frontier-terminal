import { VendorMdPricingOutput, modelKey, type PriceRow, type Provenance } from '../../contracts'
import {
  htmlSections,
  htmlText,
  htmlTablesUnder,
  stripInvisible,
  usdPerMillion,
  type HtmlSection,
} from './html-table'
import { tablesUnderHeading } from './md-table'

// OpenAI's own pricing pages as the Internet Archive captured them, before the
// docs origin served markdown (archive/eras.ts names each era's URL and
// window). One PriceRow per model id and service tier, the same keys
// openai-pricing-md writes, so an archived observation of gpt-4o lands on
// the live SKU's history. Only the token price lists are read; fine-tuning,
// embeddings, images, audio, realtime and tools are not, exactly as live.
// Anything the parser does not recognise throws, and the capture is skipped
// with the error as its reason: no row is ever guessed.

/** An API model id as the pages print it: gpt-4o-2024-05-13, o1-mini, chatgpt-4o-latest. */
const MODEL_ID = /^(?:gpt|chatgpt|o\d|davinci|babbage)[a-z0-9.-]*$/

/**
 * Until November 2023 the page printed GPT-4's and GPT-3.5 Turbo's SKUs by
 * context length under the family's heading rather than by id. The ids are
 * the ones the same page's "Learn more" docs named for those context
 * lengths, and from November 2023 the page itself printed gpt-4 and
 * gpt-4-32k in the same rows at the same prices. Only these headings and
 * these labels are mapped; any other label throws.
 */
const CONTEXT_ROWS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'GPT-4': { '8K context': 'gpt-4', '32K context': 'gpt-4-32k' },
  'GPT-3.5 Turbo': { '4K context': 'gpt-3.5-turbo', '16K context': 'gpt-3.5-turbo-16k' },
  Chat: { '4K context': 'gpt-3.5-turbo', '16K context': 'gpt-3.5-turbo-16k' },
}

/** Sections that list non-token or non-chat prices: never read. */
const EXCLUDED = /fine-tun|embedding|image|audio|assistant|realtime|moderation|tool|base model/i

/** "$0.03 / 1K tokens" | "$10.00 / 1 M tokens" -> $/MTok. */
function perMillion(cell: string): number {
  const unit = cell.match(/\/\s*1\s*([KM])\s*tokens/i)
  if (!unit) throw new Error(`no per-token unit: ${cell}`)
  return usdPerMillion(cell, unit[1] === 'K' ? 1_000 : 1_000_000)
}

function base(slug: string, prov: Provenance): PriceRow {
  return {
    provider: 'openai',
    model_slug: slug,
    tier: null,
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

const keyOf = (r: PriceRow) => modelKey(r.provider, r.model_slug, r.tier)

/**
 * One row per key. The same key printed twice at the same prices (a model in
 * both "GPT-4o" and "Other models") is one row; at different prices it is a
 * page we cannot read without choosing, so it throws.
 */
function finish(rows: PriceRow[], what: string) {
  const byKey = new Map<string, PriceRow>()
  for (const r of rows) {
    const held = byKey.get(keyOf(r))
    if (!held) {
      byKey.set(keyOf(r), r)
      continue
    }
    const same =
      held.input_per_mtok === r.input_per_mtok &&
      held.cached_input_per_mtok === r.cached_input_per_mtok &&
      held.output_per_mtok === r.output_per_mtok
    if (!same) throw new Error(`${what}: ${keyOf(r)} printed twice at different prices`)
  }
  if (byKey.size === 0) throw new Error(`${what}: no token price rows`)
  const out = [...byKey.values()].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))
  return VendorMdPricingOutput.parse({ rows: out })
}

// ---- openai.com/pricing, 2023-01 to 2024-05 ---------------------------------

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * One table per model family under an h3 ("GPT-4 Turbo", "GPT-4", "Chat",
 * "GPT-3.5 Turbo", "Older models"), prices per 1K tokens until April 2024 and
 * per 1M after. Read: tables headed Model | Input | Output or Model | Prompt |
 * Completion, and the 2023 "Chat" table's single Usage price, which the page
 * charged for prompt and completion tokens alike and is stored as both.
 */
export function parseOpenAiPricingHtml2023(html: string, prov: Provenance) {
  const rows: PriceRow[] = []
  const sections: HtmlSection[] = htmlSections(html)
  for (const s of sections) {
    if (EXCLUDED.test(s.heading)) continue
    for (const table of s.tables) {
      const [header, ...body] = table
      if (!header) continue
      const twoPrice =
        same(header, ['Model', 'Input', 'Output']) ||
        same(header, ['Model', 'Prompt', 'Completion'])
      const usage = s.heading === 'Chat' && same(header, ['Model', 'Usage'])
      if (!twoPrice && !usage) continue
      for (const cells of body) {
        if (cells.length !== header.length) {
          throw new Error(`${s.heading}: row has ${cells.length} cells: ${cells[0]}`)
        }
        const name = cells[0]!
        const mapped = CONTEXT_ROWS[s.heading]?.[name]
        const slug = mapped ?? (MODEL_ID.test(name) ? name : null)
        if (!slug) throw new Error(`${s.heading}: unrecognised model cell: ${name}`)
        const row = base(slug, prov)
        if (mapped) row.notes = `printed as "${name}" under ${s.heading}`
        if (usage) {
          const price = perMillion(cells[1]!)
          rows.push({
            ...row,
            input_per_mtok: price,
            output_per_mtok: price,
            notes: 'one usage price for prompt and completion tokens',
          })
        } else {
          rows.push({
            ...row,
            input_per_mtok: perMillion(cells[1]!),
            output_per_mtok: perMillion(cells[2]!),
          })
        }
      }
    }
  }
  return finish(rows, 'openai.com/pricing')
}

// ---- openai.com/api/pricing, 2024-05 to 2025-02 ------------------------------

// Each model family is a collapsible "feature group" whose title sits in a
// text-h5 div beside its expand button; the older-models list is an h4.
const GROUP =
  /<div class="text-h5[^"]*">([^<]*)<button[^>]*aria-label="Expand feature group"[^>]*>/g
const H4 = /<h4\b[^>]*>([\s\S]*?)<\/h4>/g

/** The three row headers the token tables print, in visible text. */
const HEADERS = [
  { text: 'Model Pricing Pricing with Batch API*', batch: true, labelled: true },
  { text: 'Model Pricing', batch: false, labelled: true },
  { text: 'Model Input Output', batch: false, labelled: false },
] as const

const AMOUNT = String.raw`\$\d[\d,]*(?:\.\d+)? / 1 ?[MK] (?:[a-z*]+ )*[Tt]okens`
const ROW = new RegExp(String.raw`^ ([a-z0-9][a-z0-9.-]*)((?: ${AMOUNT})+)`)
// A row priced per modality ("gpt-4o-audio-preview Text $2.50 … Audio*** $100 …"):
// not a single token price, so it is passed over and named on the capture.
const MODALITY_ROW = new RegExp(
  String.raw`^ ([a-z0-9][a-z0-9.-]*)((?: (?:Text|Audio|Image|Video)\**(?: ${AMOUNT})+)+)`,
)
const PRICED = /\$\d[\d,]*(?:\.\d+)? \/ 1 ?[MK] (?:[a-z*]+ )*[Tt]okens/
const AMOUNT_PARTS = /\$(\d[\d,]*(?:\.\d+)?) \/ 1 ?([MK]) ((?:[a-z*]+ )*)[Tt]okens/g

interface Section {
  title: string
  text: string
}

function featureGroups(html: string): Section[] {
  const clean = stripInvisible(html)
  const marks: { at: number; end: number; title: string }[] = []
  for (const m of clean.matchAll(GROUP)) {
    marks.push({ at: m.index, end: m.index + m[0].length, title: htmlText(m[1]!) })
  }
  for (const m of clean.matchAll(H4)) {
    marks.push({ at: m.index, end: m.index + m[0].length, title: htmlText(m[1]!) })
  }
  marks.sort((a, b) => a.at - b.at)
  return marks.map((m, i) => ({
    title: m.title,
    text: htmlText(clean.slice(m.end, marks[i + 1]?.at ?? clean.length)),
  }))
}

type Label = 'input' | 'cached input' | 'output' | ''

function amounts(run: string): { price: number; label: Label }[] {
  const out: { price: number; label: Label }[] = []
  for (const m of run.matchAll(AMOUNT_PARTS)) {
    const label = m[3]!.replace(/\*/g, '').trim()
    if (label !== '' && label !== 'input' && label !== 'cached input' && label !== 'output') {
      throw new Error(`unknown price label: ${label}`)
    }
    out.push({
      price: usdPerMillion(`$${m[1]!.replace(/,/g, '')}`, m[2] === 'K' ? 1_000 : 1_000_000),
      label,
    })
  }
  return out
}

/**
 * The 2024 redesign: no tables, a grid of divs whose visible text reads
 * "Model Input Output gpt-4o $5.00 / 1M tokens $15.00 / 1M tokens …", and
 * from August "Model Pricing Pricing with Batch API* gpt-4o $2.50 / 1M input
 * tokens $1.25 / 1M input tokens $1.25 / 1M cached** input tokens $10.00 / 1M
 * output tokens $5.00 / 1M output tokens". Under the batch header each label
 * prints the standard price, then the batch price; cached input is printed
 * for the standard tier only. A batch price above its standard price would
 * mean that reading is wrong, so it throws.
 */
export function parseOpenAiPricingHtml2024(html: string, prov: Provenance) {
  const rows: PriceRow[] = []
  const passed: string[] = []
  for (const section of featureGroups(html)) {
    if (EXCLUDED.test(section.title)) continue
    let text = ` ${section.text}`
    const before = rows.length
    const passedBefore = passed.length
    for (;;) {
      const at = HEADERS.map((h) => ({ h, i: text.indexOf(` ${h.text} `) }))
        .filter((x) => x.i !== -1)
        .sort((a, b) => a.i - b.i || b.h.text.length - a.h.text.length)[0]
      if (!at) break
      text = text.slice(at.i + at.h.text.length + 1)
      for (;;) {
        const modal = text.match(MODALITY_ROW)
        if (modal) {
          passed.push(modal[1]!)
          text = text.slice(modal[0].length)
          continue
        }
        const m = text.match(ROW)
        if (!m) break
        text = text.slice(m[0].length)
        rows.push(...rowsFor(m[1]!, amounts(m[2]!), at.h, prov))
      }
    }
    // A family that prints token prices the grammar did not read is a layout
    // we do not know (January 2025 moved each header into its row). Reading
    // the families we do know and dropping the rest would turn the unread
    // ones into delistings, so the whole capture is skipped instead.
    if (rows.length === before && passed.length === passedBefore && PRICED.test(section.text)) {
      throw new Error(
        `${section.title || 'untitled section'}: prices in a layout this parser does not read`,
      )
    }
  }
  // The passed-over rows go on the capture's record, not on every price row:
  // a row's content hash must change only when its own prices do.
  return { ...finish(rows, 'openai.com/api/pricing'), passed: [...new Set(passed)].sort() }
}

function rowsFor(
  slug: string,
  prices: { price: number; label: Label }[],
  header: (typeof HEADERS)[number],
  prov: Provenance,
): PriceRow[] {
  if (!MODEL_ID.test(slug)) throw new Error(`unrecognised model id: ${slug}`)
  if (!header.labelled) {
    if (prices.length !== 2 || prices.some((p) => p.label !== '')) {
      throw new Error(`${slug}: expected an input and an output price`)
    }
    return [
      { ...base(slug, prov), input_per_mtok: prices[0]!.price, output_per_mtok: prices[1]!.price },
    ]
  }
  const by = (label: Label) => prices.filter((p) => p.label === label).map((p) => p.price)
  const [input, cached, output] = [by('input'), by('cached input'), by('output')]
  if (prices.some((p) => p.label === '')) throw new Error(`${slug}: unlabelled price`)
  const most = header.batch ? 2 : 1
  if (input.length < 1 || input.length > most || output.length !== input.length) {
    throw new Error(`${slug}: ${input.length} input and ${output.length} output prices`)
  }
  if (cached.length > 1) throw new Error(`${slug}: ${cached.length} cached-input prices`)
  const standard: PriceRow = {
    ...base(slug, prov),
    input_per_mtok: input[0]!,
    cached_input_per_mtok: cached[0] ?? null,
    output_per_mtok: output[0]!,
  }
  if (input.length === 1) return [standard]
  if (input[1]! > input[0]! || output[1]! > output[0]!) {
    throw new Error(`${slug}: batch price above the standard price`)
  }
  return [
    standard,
    { ...base(slug, prov), tier: 'batch', input_per_mtok: input[1]!, output_per_mtok: output[1]! },
  ]
}

// ---- developers.openai.com/api/docs/pricing, 2026-02 onward (HTML) ----------

/** The service-tier tab a "Text tokens" table sits under -> the tier openai-pricing-md writes. */
const TIER_TABS: Readonly<Record<string, string | null>> = {
  Standard: null,
  Batch: 'batch',
  Flex: 'flex',
  Priority: 'priority',
}

const TEXT_TOKENS_HEADER = ['Model', 'Input', 'Cached input', 'Output'] as const

/**
 * The docs site before it served markdown: a "Text tokens" h2 with one
 * Model | Input | Cached input | Output table per service tier, each table
 * preceded by its tab's label (Batch, Flex, Standard, Priority). "-" is a
 * price the tier does not offer. A table whose label is not one of those
 * four, or whose columns differ, throws.
 */
export function parseOpenAiDocsPricingHtml(html: string, prov: Provenance) {
  const tables = htmlTablesUnder(htmlSections(html), 'Text tokens')
  const leads = textTokenLeads(html)
  if (leads.length !== tables.length) {
    throw new Error(`Text tokens: ${tables.length} tables but ${leads.length} tier labels`)
  }
  const rows: PriceRow[] = []
  tables.forEach((table, i) => {
    const label = leads[i]!
    if (!(label in TIER_TABS)) throw new Error(`Text tokens: unknown tier tab ${label}`)
    const [header, ...body] = table
    if (!header || !same(header, TEXT_TOKENS_HEADER)) {
      throw new Error(`Text tokens: columns changed: ${header?.join(' | ')}`)
    }
    for (const cells of body) {
      // "gpt-5.4 (<272K context length)": the short-context bound, kept in
      // notes as openai-pricing-md keeps it, never read as a window.
      const m = cells[0]!.match(/^([a-z0-9][a-z0-9.-]*)(?: \((.+)\))?$/)
      if (!m) throw new Error(`unrecognised model id: ${cells[0]}`)
      const price = (cell: string) => (cell === '-' ? null : usdPerMillion(cell, 1_000_000))
      rows.push({
        ...base(m[1]!, prov),
        notes: m[2] ? `short context: ${m[2]}` : null,
        tier: TIER_TABS[label]!,
        input_per_mtok: price(cells[1]!),
        cached_input_per_mtok: price(cells[2]!),
        output_per_mtok: price(cells[3]!),
      })
    }
  })
  return finish(rows, 'developers.openai.com/api/docs/pricing')
}

/** The tab label printed just before each table in the Text tokens section. */
function textTokenLeads(html: string): string[] {
  const clean = stripInvisible(html)
  const start = clean.search(/<h2\b[^>]*>(?:(?!<\/h2>)[\s\S])*Text tokens/)
  if (start === -1) return []
  const rest = clean.slice(start)
  const end = rest.slice(1).search(/<h2\b/)
  const section = end === -1 ? rest : rest.slice(0, end + 1)
  const out: string[] = []
  let prev = 0
  for (const m of section.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const words = htmlText(section.slice(prev, m.index)).split(' ')
    out.push(words.at(-1) ?? '')
    prev = m.index + m[0].length
  }
  return out
}

// ---- developers.openai.com/api/docs/pricing.md, 2026-07 to the live start ----

/** The tier sections the mid-2026 markdown prints, and the tier names openai-pricing-md writes. */
const MD_TIERS: readonly { heading: string; tier: string | null; long: string }[] = [
  { heading: '### Standard pricing data', tier: null, long: 'long_context' },
  { heading: '### Batch pricing data', tier: 'batch', long: 'batch_long_context' },
  { heading: '### Flex pricing data', tier: 'flex', long: 'flex_long_context' },
  { heading: '### Fast pricing data', tier: 'fast', long: 'fast_long_context' },
  { heading: '### Priority pricing data', tier: 'priority', long: 'priority_long_context' },
]

const MD_COLUMNS = [
  'Model',
  'Short context input',
  'Short context cached input',
  'Short context cache writes',
  'Short context output',
  'Long context input',
  'Long context cached input',
  'Long context cache writes',
  'Long context output',
] as const

/**
 * The markdown twin as the Archive first held it (2026-07-29 and 2026-08-06):
 * one table per service tier with a single cache-writes column, before the
 * October redesign the live parser reads. Same rows and tiers as
 * openai-pricing-md: a short-context row per model, a long-context row where
 * one is printed, the "(<272K context length)" bound kept in notes.
 */
export function parseOpenAiPricingMd2026(text: string, prov: Provenance) {
  const rows: PriceRow[] = []
  const amount = (cell: string) => (cell === '-' ? null : usdPerMillion(cell, 1_000_000))
  let tiers = 0
  for (const { heading, tier, long } of MD_TIERS) {
    if (!text.split('\n').some((l) => l.trim() === heading)) continue // a tier this capture lacks
    tiers++
    const tables = tablesUnderHeading(text, heading)
    if (tables.length !== 1) throw new Error(`${heading}: ${tables.length} tables, expected 1`)
    const [header, ...body] = tables[0]!
    // Priority prints the short-context columns only.
    if (!header || !(same(header, MD_COLUMNS) || same(header, MD_COLUMNS.slice(0, 5)))) {
      throw new Error(`${heading}: columns changed: ${header?.join(' | ')}`)
    }
    const at = (cells: string[], name: (typeof MD_COLUMNS)[number]) => {
      const i = header.indexOf(name)
      return i === -1 ? null : amount(cells[i]!)
    }
    for (const cells of body) {
      if (cells.length !== header.length) {
        throw new Error(`${heading}: row has ${cells.length} cells: ${cells[0]}`)
      }
      const m = cells[0]!.match(/^([a-z0-9][a-z0-9.-]*)(?: \((.+)\))?$/)
      if (!m) throw new Error(`unrecognised model id: ${cells[0]}`)
      rows.push({
        ...base(m[1]!, prov),
        tier,
        input_per_mtok: at(cells, 'Short context input'),
        cached_input_per_mtok: at(cells, 'Short context cached input'),
        output_per_mtok: at(cells, 'Short context output'),
        notes: m[2] ? `short context: ${m[2]}` : null,
      })
      const longInput = at(cells, 'Long context input')
      const longOutput = at(cells, 'Long context output')
      if (longInput !== null || longOutput !== null) {
        rows.push({
          ...base(m[1]!, prov),
          tier: long,
          input_per_mtok: longInput,
          cached_input_per_mtok: at(cells, 'Long context cached input'),
          output_per_mtok: longOutput,
          notes: m[2] ? `long context: beyond ${m[2]}` : 'long context',
        })
      }
    }
  }
  if (tiers === 0) throw new Error('heading not found: ### Standard pricing data')
  return finish(rows, 'developers.openai.com/api/docs/pricing.md')
}
