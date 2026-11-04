import { VendorMdPricingOutput, modelKey, type PriceRow, type Provenance } from '../../contracts'
import {
  decodeEntities,
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
          passed.push(`${modal[1]!} (priced per modality)`)
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

// ---- openai.com/api/pricing, 2025-01-28 to 2025-03-03 -------------------------

/**
 * Ids the late-January 2025 page misprinted, and the id it meant. The o3-mini
 * family printed its dated snapshot as "03-mini-2025-01-31" (a zero for the
 * letter o) under the "OpenAI o3-mini" heading, beside o3-mini at the same
 * prices; the API id is o3-mini-2025-01-31. Only these exact strings are
 * mapped, and the printed form stays in notes.
 */
const MISPRINTS: Readonly<Record<string, string>> = { '03-mini-2025-01-31': 'o3-mini-2025-01-31' }

const ROW_START_2025 =
  / ([a-z0-9][a-z0-9.-]*) (?:Pricing(?: Pricing with Batch API\**)?|Input Output) (?=\$|(?:Text|Audio|Image|Video)\**\s)/g
// "Other models": "gpt-4-turbo Input Output $10.00 / 1M tokens $30.00 / 1M tokens",
// the column header printed in the row, cached input labelled after output.
const USD_AMOUNT = String.raw`\$(\d[\d,]*(?:\.\d+)?)`
const OTHER_ROW_2025 = new RegExp(
  String.raw`^ ([a-z0-9][a-z0-9.-]*) Input Output ${USD_AMOUNT} / 1M tokens ${USD_AMOUNT} / 1M tokens(?: ${USD_AMOUNT} / 1M cached\* tokens)?(?= |$)`,
)
const ROW_2025 = new RegExp(
  String.raw`^ ([a-z0-9][a-z0-9.-]*) (Pricing Pricing with Batch API\**|Pricing)((?: ${AMOUNT})+)`,
)
const MODALITY_ROW_2025 = new RegExp(
  String.raw`^ ([a-z0-9][a-z0-9.-]*) (?:Pricing Pricing with Batch API\**|Pricing)((?: (?:Text|Audio|Image|Video)\**(?: ${AMOUNT})+)+)`,
)

/**
 * The late-January 2025 redesign of openai.com/api/pricing: the same feature
 * groups and the same price runs as 2024, but each row now opens with its
 * own column header ("gpt-4o Pricing Pricing with Batch API* $2.50 / 1M input
 * tokens …") instead of sharing one above the list. The prices are read by
 * the 2024 rules (rowsFor). From March 2025 the page became a summary of a
 * few flagship models by marketing name, which this parser does not read.
 */
export function parseOpenAiPricingHtml2025(html: string, prov: Provenance) {
  const groups = featureGroups(html)
  const visible = htmlText(stripInvisible(html))
  if (groups.length === 0 && !PRICED.test(visible)) {
    throw new Error('the capture holds the page shell only: its prices are in scripts')
  }
  if (groups.length === 0 && /Our latest models/.test(visible)) {
    throw new Error('the page lists a few flagship models by marketing name, not the price list')
  }
  const rows: PriceRow[] = []
  const passed: string[] = []
  for (const section of groups) {
    if (EXCLUDED.test(section.title)) continue
    const text = ` ${section.text} `
    const before = rows.length
    const passedBefore = passed.length
    for (const start of text.matchAll(ROW_START_2025)) {
      const rest = text.slice(start.index)
      const other = rest.match(OTHER_ROW_2025)
      if (other) {
        const slug = other[1]!
        if (!MODEL_ID.test(slug)) throw new Error(`unrecognised model id: ${slug}`)
        const usd = (a: string) => usdPerMillion(`$${a.replace(/,/g, '')}`, 1_000_000)
        rows.push({
          ...base(slug, prov),
          input_per_mtok: usd(other[2]!),
          output_per_mtok: usd(other[3]!),
          cached_input_per_mtok: other[4] ? usd(other[4]) : null,
        })
        continue
      }
      const modal = rest.match(MODALITY_ROW_2025)
      if (modal) {
        passed.push(`${modal[1]!} (priced per modality)`)
        continue
      }
      const m = rest.match(ROW_2025)
      if (!m) throw new Error(`${section.title}: ${start[1]}: a row this parser does not read`)
      const printed = m[1]!
      const slug = MISPRINTS[printed] ?? printed
      const header = m[2]!.startsWith('Pricing Pricing with Batch API') ? HEADERS[0] : HEADERS[1]
      const prices = amounts(m[3]!)
      // One row (o1-preview-2024-09-12) printed its output price as "$60.00 / 1M
      // tokens", without the word output. Which price it is would be inferred
      // from its position, so the row is not read, and the capture names it.
      if (prices.some((p) => p.label === '')) {
        passed.push(`${printed} (a price printed without its input or output label)`)
        continue
      }
      const read = rowsFor(slug, prices, header, prov)
      rows.push(
        ...(slug === printed
          ? read
          : read.map((r) => ({ ...r, notes: `printed as "${printed}"` }))),
      )
    }
    if (rows.length === before && passed.length === passedBefore && PRICED.test(section.text)) {
      throw new Error(
        `${section.title || 'untitled section'}: prices in a layout this parser does not read`,
      )
    }
  }
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
      // "-" and "/" mark a price the tier does not offer; an empty cell prints none either.
      const price = (cell: string) =>
        cell === '-' || cell === '/' || cell === '' ? null : usdPerMillion(cell, 1_000_000)
      // "gpt-5.4 (>272K context length)", a row of its own from March 2026: the
      // long-context price, filed under the tier openai-pricing-md gives it.
      const long = m[2]?.startsWith('>') ?? false
      const tier = TIER_TABS[label]!
      rows.push({
        ...base(m[1]!, prov),
        notes: m[2] ? `${long ? 'long' : 'short'} context: ${m[2]}` : null,
        tier: long ? (tier ? `${tier}_long_context` : 'long_context') : tier,
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

// ---- developers.openai.com/api/docs/pricing, 2026-03-08 to 2026-07-29 (HTML) --

/** The `tier` prop of each text-token price list -> the tier openai-pricing-md writes. */
const ISLAND_TIERS: Readonly<Record<string, string | null>> = {
  standard: null,
  batch: 'batch',
  flex: 'flex',
  priority: 'priority',
}

/** A price cell in the island props: a number, or one of the marks the page prints for "no price". */
function islandPrice(cell: unknown, where: string): number | null {
  if (typeof cell === 'number' && Number.isFinite(cell) && cell >= 0) return cell
  if (cell === null || cell === '' || cell === '-' || cell === '/') return null
  throw new Error(`${where}: unrecognised price cell ${JSON.stringify(cell)}`)
}

/** Astro's prop encoding: [0, value] is a plain value, [1, [...]] an array of encoded values. */
function unwrap(encoded: unknown): unknown {
  if (!Array.isArray(encoded) || encoded.length !== 2)
    throw new Error('island props: not [tag, value]')
  const [tag, value] = encoded as [unknown, unknown]
  if (tag === 0) return value
  if (tag === 1 && Array.isArray(value)) return value.map(unwrap)
  throw new Error(`island props: unknown tag ${String(tag)}`)
}

/** The short-context column names of the page's visible text-token tables, after Model. */
function visibleColumns(sections: readonly HtmlSection[]): string[][] {
  const out: string[][] = []
  for (const table of textTokenTables(sections)) {
    const header = table.header
    const outputAt = header.indexOf('Output')
    if (outputAt === -1) throw new Error(`no Output column: ${header.join(' | ')}`)
    out.push(header.slice(1, outputAt + 1))
  }
  return out
}

/**
 * The visible text-token tables: a "Short context" super-header row, then a
 * Model | Input | … header. Image and audio token tables have no super-header.
 */
function textTokenTables(sections: readonly HtmlSection[]) {
  const out: { header: string[]; body: string[][] }[] = []
  for (const s of sections) {
    for (const table of s.tables) {
      const h = table.findIndex((r) => r[0] === 'Model' && r[1] === 'Input')
      if (h < 1 || !table.slice(0, h).some((r) => r.includes('Short context'))) continue
      out.push({ header: table[h]!, body: table.slice(h + 1) })
    }
  }
  return out
}

/**
 * From March 2026 the docs pricing page showed only "Our latest models" in
 * each service-tier tab and drew the full list behind a "View all" button.
 * The full list is still in the server-rendered HTML: each tab's table is an
 * <astro-island> whose `props` attribute holds that tab's tier and its rows
 * (model, then one number per short-context column). Those props are read
 * here, and nothing from the island's script.
 *
 * The props name no columns, so the columns are taken from the page's own
 * visible tables (Model | Input | Cached input | [Cache writes |] Output):
 * every visible table must agree on them, each props row must have exactly
 * that many cells, and every visible row's short-context prices must equal
 * the same model's props row in some tier. A page where any of that fails
 * is skipped. Long-context columns, printed only for the latest models, are
 * not read here, as the March 2026 era before this one did not read them.
 */
export function parseOpenAiDocsPricingIslands(html: string, prov: Provenance) {
  const sections = htmlSections(html)
  // The first captures of this window still print every model in one table per tier.
  if (textTokenTables(sections).length === 0) return parseOpenAiDocsPricingHtml(html, prov)
  const layouts = visibleColumns(sections)
  const columns = layouts[0]!
  if (layouts.some((l) => !same(l, columns))) {
    throw new Error(
      `visible tables disagree on columns: ${layouts.map((l) => l.join('|')).join(' vs ')}`,
    )
  }
  const at = (name: string) => columns.indexOf(name)
  if (at('Input') !== 0 || at('Cached input') !== 1 || at('Output') !== columns.length - 1) {
    throw new Error(`unknown column layout: ${columns.join(' | ')}`)
  }

  const rows: PriceRow[] = []
  const seen = new Set<string>()
  const printed = new Map<string, (number | null)[]>()
  for (const m of html.matchAll(/<astro-island\b([^>]*)>/g)) {
    const raw = m[1]!.match(/\sprops="([^"]*)"/)?.[1]
    if (!raw) continue
    const props = JSON.parse(decodeEntities(raw)) as Record<string, unknown>
    if (!('tier' in props) || !('rows' in props)) continue
    const tierName = unwrap(props.tier)
    if (typeof tierName !== 'string' || !(tierName in ISLAND_TIERS)) {
      throw new Error(`unknown tier prop ${JSON.stringify(tierName)}`)
    }
    if (seen.has(tierName)) throw new Error(`two ${tierName} price lists`)
    seen.add(tierName)
    const list = unwrap(props.rows)
    if (!Array.isArray(list)) throw new Error(`${tierName}: rows is not a list`)
    for (const listed of list as unknown[][]) {
      // Once the page added a Cache writes column (mid-2026), rows for older
      // models kept the three prices they had before it: Input, Cached input,
      // Output, the layout of this same list in March 2026. Such a row is read
      // in that layout, with no cache-write price; any other width throws.
      const short = listed.length === 4 && columns.length === 4 && at('Cache writes') === 2
      const cells = short ? [listed[0], listed[1], listed[2], null, listed[3]] : listed
      if (cells.length !== columns.length + 1) {
        throw new Error(
          `${tierName}: a row has ${listed.length} cells, expected ${columns.length + 1}`,
        )
      }
      const name = cells[0]
      const mm =
        typeof name === 'string' ? name.match(/^([a-z0-9][a-z0-9.-]*)(?: \((.+)\))?$/) : null
      if (!mm) throw new Error(`${tierName}: unrecognised model id: ${String(name)}`)
      const where = `${tierName} ${mm[1]}`
      const priced = cells.slice(1).map((c) => islandPrice(c, where))
      printed.set(`${tierName}:${mm[1]}`, priced)
      rows.push({
        ...base(mm[1]!, prov),
        tier: ISLAND_TIERS[tierName]!,
        notes: mm[2] ? `short context: ${mm[2]}` : null,
        input_per_mtok: priced[at('Input')]!,
        cached_input_per_mtok: priced[at('Cached input')]!,
        output_per_mtok: priced[at('Output')]!,
      })
    }
  }
  if (!seen.has('standard')) throw new Error('no standard-tier price list in the page')

  // Every visible row must be one of the props rows, cell for cell.
  const tiers = [...seen]
  const cell = (c: string) =>
    c === '-' || c === '' || c === '/' ? null : usdPerMillion(c, 1_000_000)
  for (const { body } of textTokenTables(sections)) {
    for (const r of body) {
      const visible = r.slice(1, columns.length + 1).map(cell)
      const match = tiers.some((t) => {
        const held = printed.get(`${t}:${r[0]}`)
        return held !== undefined && held.every((p, i) => p === visible[i])
      })
      if (!match) throw new Error(`visible row ${r[0]} matches no price list in the page`)
    }
  }
  return finish(rows, 'developers.openai.com/api/docs/pricing')
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
