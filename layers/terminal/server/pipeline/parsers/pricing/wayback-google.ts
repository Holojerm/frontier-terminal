import { VendorMdPricingOutput, modelKey, type PriceRow, type Provenance } from '../../contracts'
import { priceTier } from '../../normalize'
import { htmlText, stripInvisible, usdPerMillion } from './html-table'
import { parseGooglePricingPage } from './google-pricing'

// Google's own Gemini API pricing pages as the Internet Archive captured them
// (archive/eras.ts names each era's URL and window). Two shapes:
//
//   2024-05 to 2025-02, ai.google.dev/pricing: one card per model, a "Free of
//   charge" column and a "Pay-as-you-go" column, prices in running text with
//   a prompt-length condition ("$0.35 / 1 million tokens (for prompts up to
//   128K tokens) $0.70 / 1 million tokens (for prompts longer than 128K)").
//   2025-02 onward, ai.google.dev/gemini-api/docs/pricing: one <h2> per model
//   and one three-column table per service tier, the HTML the live parser
//   (google-pricing.ts) was written for. It is read by that parser, so the
//   two cannot disagree about a cell.
//
// Every row lands on the key the live pages use (model:google:<id>:<tier>).
// How an archived section gets its id and its tier, when the page did not
// print them the way the live page does, is stated at each step below.

function base(slug: string, prov: Provenance): PriceRow {
  return {
    provider: 'google',
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

// A scheduled price ("$1.50 starting January 1, 2027") is its own row beside the current one.
const keyOf = (r: PriceRow) => modelKey(r.provider, r.model_slug, priceTier(r))

function sorted(rows: PriceRow[], what: string) {
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(keyOf(r))) throw new Error(`${what}: ${keyOf(r)} priced twice`)
    seen.add(keyOf(r))
  }
  if (rows.length === 0) throw new Error(`${what}: no token price rows`)
  return VendorMdPricingOutput.parse({
    rows: [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)),
  })
}

// ---- ai.google.dev/gemini-api/docs/pricing, 2025-02 onward ------------------

const H2 = /<h2 id="([^"]+)"[^>]*>/g
const TIER_HEADING = /<h3\b[^>]*>(?:Standard|Batch|Flex|Priority)<\/h3>/
/** The AI Studio link under a model heading: `aistudio.google.com?model=<id>`. */
const STUDIO_MODEL = /aistudio\.google\.com\/?\?model=([a-z0-9][a-z0-9.-]*)"/g

/**
 * Until late 2025 the page printed no `<code>` model id under a heading; the
 * id it named was the model in its own "Try it in Google AI Studio" link
 * (`aistudio.google.com?model=gemini-2.0-flash`), the same id the page
 * printed in <code> from November 2025. Such a link is turned into the
 * <code> the live parser reads, and only when the section has exactly one:
 * a section with none or with several is left for the live parser to skip.
 */
function codesFromStudioLinks(html: string): string {
  const heads = [...html.matchAll(H2)]
  let out = html.slice(0, heads[0]?.index ?? html.length)
  heads.forEach((head, i) => {
    let section = html.slice(head.index, heads[i + 1]?.index ?? html.length)
    const firstTable = section.indexOf('<table')
    const lead = firstTable === -1 ? section : section.slice(0, firstTable)
    if (!/<code[^>]*>/.test(lead)) {
      const ids = [...new Set([...lead.matchAll(STUDIO_MODEL)].map((m) => m[1]!))]
      if (ids.length === 1) {
        const close = section.indexOf('</h2>') + '</h2>'.length
        section = `${section.slice(0, close)}<code>${ids[0]}</code>${section.slice(close)}`
      }
    }
    out += section
  })
  return out
}

/**
 * The docs pricing page through the live parser. Two archived-only steps:
 * model ids from the AI Studio links (codesFromStudioLinks), and the tier of
 * a page that printed no tier headings at all. Until September 2025 every
 * model had one paid table and no "Standard" / "Batch" heading; that table
 * is the price the live page files under Standard, so its rows take tier
 * `standard` (the key the live pages use) and say so in notes. On a page
 * that does print tier headings, an untiered table stays untiered, as live.
 * Sections the live parser skips for want of a model id are named on the
 * capture; image, video and music tables (per image / second / request) are
 * not token prices and are left out, as live.
 */
export function parseGoogleDocsPricingHtml(html: string, prov: Provenance) {
  const tiered = TIER_HEADING.test(stripInvisible(html))
  const page = parseGooglePricingPage(codesFromStudioLinks(html), prov)
  const rows = page.rows.map((r) =>
    tiered || r.tier !== null
      ? r
      : {
          ...r,
          tier: 'standard',
          notes: [r.notes, 'the only paid price: the page printed no service tiers']
            .filter(Boolean)
            .join('; '),
        },
  )
  // Sections with a per-token table but no id are named; image, video and
  // music sections are not token prices and are left out, as live.
  const tokenPriced = new Set(
    [...html.matchAll(H2)]
      .map((m, i, all) => ({
        id: m[1]!,
        body: html.slice(m.index, all[i + 1]?.index ?? html.length),
      }))
      .filter((x) => x.body.includes('per 1M tokens in USD'))
      .map((x) => x.id),
  )
  const passed = page.skipped
    .filter((s) => /no <code> model id/.test(s.reason) && tokenPriced.has(s.slug))
    .map((s) => `${s.slug} (no model id on the page)`)
  return { ...sorted(rows, 'ai.google.dev/gemini-api/docs/pricing'), passed: [...new Set(passed)] }
}

// ---- ai.google.dev/pricing, 2024-05 to 2025-02 ------------------------------

/**
 * The card titles this era printed, and the API id each one is filed under.
 * The cards print no id. Each id here is the one Google's next pricing page
 * (ai.google.dev/gemini-api/docs/pricing, February 2025) linked from the
 * section with the same anchor ("gemini-1.5-flash" -> AI Studio
 * `?model=gemini-1.5-flash`). Cards whose model that page never linked
 * (Gemini 1.0 Pro, Text Embedding 004) are not read and are named on the
 * capture. Any other title throws.
 */
const CARD_IDS: Readonly<Record<string, string | null>> = {
  'Gemini 1.5 Flash': 'gemini-1.5-flash',
  'Gemini 1.5 Flash-8B': 'gemini-1.5-flash-8b',
  'Gemini 1.5 Pro': 'gemini-1.5-pro',
  'Gemini 1.0 Pro': null,
  'Text Embedding 004': null,
}

const PER_MTOK = String.raw`\$(\d[\d,]*(?:\.\d+)?) \/ 1 million tokens`

/**
 * One card's pay-as-you-go text -> its three prices, short-prompt price
 * first. Two layouts:
 *   mid-2024: "Price (input) $0.35 / 1 million tokens (for prompts up to
 *     128K tokens) $0.70 / 1 million tokens (for prompts longer than 128K)
 *     Context caching $0.0875 … Price (output) $1.05 …"
 *   January 2025: "Prompts up to 128k tokens Input Pricing $0.075 / 1 million
 *     tokens output Pricing $0.30 / 1 million tokens Context Caching $0.01875
 *     / 1 million tokens Prompts longer than 128k Input Pricing $0.15 …"
 * The short-prompt price is the row's price and the long-prompt one is kept
 * in notes, as the live parser does with "prompts <= 200k tokens" cells.
 */
function cardPrices(text: string): {
  input: number | null
  cached: number | null
  output: number | null
  notes: string[]
} {
  const usd = (amount: string) => usdPerMillion(`$${amount.replace(/,/g, '')}`, 1_000_000)
  // Late 2024 annotated each amount with a scheduled cut: "$3.50 / 1 million
  // tokens (starting October 1st, 2024 it will reduce to $1.25)". The amount
  // printed is the price in force at the capture; the annotation is kept in
  // notes, and a capture after the date shows the new price.
  const AMT = String.raw`${PER_MTOK}(?: \(([^)]*)\))?`
  const jan = text.match(
    new RegExp(
      String.raw`Prompts up to (\d+k) tokens Input Pricing ${AMT} output Pricing ${AMT}(?: Context Caching ${AMT})? Prompts longer than \d+k Input Pricing ${AMT} output Pricing ${AMT}(?: Context Caching ${AMT})?`,
      'i',
    ),
  )
  if (jan) {
    const SCHEDULED =
      /^starting [A-Z][a-z]+ \d{1,2}(?:st|nd|rd|th)?, \d{4} it will reduce to \$[\d.]+$/
    for (const said of [jan[3], jan[5], jan[7], jan[9], jan[11], jan[13]]) {
      if (said && !SCHEDULED.test(said)) {
        throw new Error(`an amount annotated in a way this parser does not read: (${said})`)
      }
    }
    return {
      input: usd(jan[2]!),
      output: usd(jan[4]!),
      cached: jan[6] ? usd(jan[6]) : null,
      notes: [
        `prompts up to ${jan[1]} tokens`,
        ...(jan[3] ? [`input: ${jan[3]}`] : []),
        ...(jan[5] ? [`output: ${jan[5]}`] : []),
        ...(jan[7] ? [`context caching: ${jan[7]}`] : []),
        `longer prompts: input $${jan[8]}, output $${jan[10]}${jan[12] ? `, context caching $${jan[12]}` : ''}`,
      ],
    }
  }
  // August 2024: "Input price (per 1M tokens) $0.075 for <= 128K tokens $0.15
  // for > 128K tokens". The page printed "<=" unescaped, so the HTML parser
  // read "<= 128K tokens" as a tag and the visible text lost it; the band
  // the first amount is for is the complement of the "> 128K" one.
  const per = (label: string, optional = false) => {
    const m = text.match(
      new RegExp(
        String.raw`${label} \(per 1M tokens\) \$([\d.,]+) for (?:<= ?\d+K tokens )?\$([\d.,]+) for > (\d+K) tokens`,
      ),
    )
    if (m)
      return { price: usd(m[1]!), note: `${label}: $${m[1]} up to ${m[3]} tokens, $${m[2]} longer` }
    const flat = text.match(new RegExp(String.raw`${label} \(per 1M tokens\) \$([\d.,]+)(?! for)`))
    if (flat) return { price: usd(flat[1]!), note: null }
    if (optional) return { price: null, note: null }
    throw new Error(`no "${label}" per-million price`)
  }
  if (/Input price \(per 1M tokens\)/.test(text)) {
    const [input, cached, output] = [
      per('Input price'),
      per('Context caching', true),
      per('Output price'),
    ]
    return {
      input: input.price,
      cached: cached.price,
      output: output.price,
      notes: [input.note, cached.note, output.note].filter((n): n is string => n !== null),
    }
  }
  if (/Input Pricing|output Pricing/i.test(text)) {
    throw new Error('a January 2025 card this parser does not read')
  }
  const band = (label: string, optional = false) => {
    const flat = text.match(new RegExp(String.raw`${label} ${PER_MTOK}(?! \()`))
    const tiered = text.match(
      new RegExp(
        String.raw`${label} ${PER_MTOK} \(for prompts up to (\d+K) tokens\) ${PER_MTOK} \(for prompts longer than \d+K\)`,
      ),
    )
    if (tiered) {
      return {
        price: usd(tiered[1]!),
        note: `${label.replace(/\\/g, '')}: $${tiered[1]} up to ${tiered[2]} tokens, $${tiered[3]} longer`,
      }
    }
    if (flat) return { price: usd(flat[1]!), note: null }
    if (optional) return { price: null, note: null }
    throw new Error(`no "${label.replace(/\\/g, '')}" per-million price`)
  }
  const input = band(String.raw`Price \(input\)`)
  const output = band(String.raw`Price \(output\)`)
  const cached = band('Context caching', true)
  return {
    input: input.price,
    cached: cached.price,
    output: output.price,
    notes: [input.note, cached.note, output.note].filter((n): n is string => n !== null),
  }
}

const CARD = /<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g
/** A card title as printed, without the availability badge January 2025 put inside the heading. */
const cardTitle = (inner: string) => htmlText(inner).replace(/ (?:Available now|Coming soon)$/, '')
const PAYG = /Pay-as-you-go(?: \(prices in USD\))?\**/

/**
 * ai.google.dev/pricing's model cards. A card's paid prices are the text
 * after its "Pay-as-you-go" heading and before the next card. A card whose
 * pay-as-you-go text prints per-1K-character prices (early 2024) is not a
 * per-token price and the capture is skipped, so a page is read whole or
 * not at all. Rows take tier `standard`: the page had one paid price per
 * model, the price the live page files under Standard.
 */
export function parseGooglePricingCards(html: string, prov: Provenance) {
  const clean = stripInvisible(html)
  const cards = [...clean.matchAll(CARD)].filter((m) => cardTitle(m[2]!) in CARD_IDS)
  if (cards.length === 0) {
    if (/\/ 1K char/.test(htmlText(clean))) throw new Error('priced per 1K characters')
    throw new Error(
      /\$\d/.test(htmlText(clean))
        ? 'no model card this parser knows'
        : 'the capture prints no prices',
    )
  }
  const rows: PriceRow[] = []
  const passed: string[] = []
  const done = new Set<string>()
  cards.forEach((card, i) => {
    const title = cardTitle(card[2]!)
    // The card list repeats its titles in a tab strip; the card is the one with prices.
    const text = htmlText(clean.slice(card.index, cards[i + 1]?.index ?? clean.length))
    const payg = text.search(PAYG)
    if (payg === -1) return
    if (done.has(title)) throw new Error(`${title}: two priced cards`)
    done.add(title)
    const paid = text.slice(payg)
    if (/\/ 1K characters/.test(paid)) throw new Error(`${title}: priced per 1K characters`)
    const id = CARD_IDS[title]
    if (!id) {
      passed.push(`${title} (no API id the page or its successor printed)`)
      return
    }
    // Spring 2024 printed pay-as-you-go prices before billing began ("Coming
    // on May 2, 2024", "Billing starts May 30, 2024"). Not yet charged, they
    // are not read as the price in force, and the capture is skipped.
    const pending = paid.match(/(?:Billing starts|Coming on) [A-Z][a-z]+ \d{1,2}, \d{4}/)
    if (pending) throw new Error(`${title}: pay-as-you-go not billed yet ("${pending[0]}")`)
    const p = cardPrices(paid)
    rows.push({
      ...base(id, prov),
      tier: 'standard',
      input_per_mtok: p.input,
      cached_input_per_mtok: p.cached,
      output_per_mtok: p.output,
      notes: [`card "${title}", pay-as-you-go`, ...p.notes].join('; '),
    })
  })
  if (done.size === 0) throw new Error('no card prints a Pay-as-you-go price')
  return { ...sorted(rows, 'ai.google.dev/pricing'), passed }
}
