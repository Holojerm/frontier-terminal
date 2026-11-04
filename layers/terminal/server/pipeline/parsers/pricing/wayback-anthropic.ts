import { VendorMdPricingOutput, modelKey, type PriceRow, type Provenance } from '../../contracts'
import { anthropicSlug, parseAnthropicPricingMd } from './anthropic-pricing'
import { htmlSections, unrenderInlineMath, usdPerMillion, type HtmlSection } from './html-table'

// Anthropic's own docs as the Internet Archive captured them (archive/eras.ts
// names each era's URL and window). Two shapes:
//
//   2024-03 to 2025-05, the models overview: "Model comparison" tables with a
//   model per column and a "Cost (Input / Output per MTok)" row.
//   2025-05 onward, the pricing page: the same "## Model pricing" and
//   "### Batch processing" tables the live pricing.md prints, rendered as
//   HTML. Those are turned back into pipe tables and read by the live
//   parser, so the two eras cannot disagree about a column.
//
// Model names changed order in 2025 ("Claude 3.5 Haiku" became "Claude Haiku
// 3.5"). The older order is rewritten to the newer before the live slug rule
// (anthropicSlug) runs, so both eras land on the key the live pages use
// (model:anthropic:claude-haiku-3-5). Nothing else about a name is changed.

const OLD_ORDER = /^Claude (\d+(?:\.\d+)?) (Opus|Sonnet|Haiku)$/

/** "Claude 3.5 Haiku" -> "Claude Haiku 3.5"; every other name verbatim. */
export function currentOrder(name: string): string {
  const m = name.match(OLD_ORDER)
  return m ? `Claude ${m[2]} ${m[1]}` : name
}

const COST_ROW = /^Cost \(Input \/ Output per MTok\W*\)$/
const COST_CELL = /^(\$\d+(?:\.\d+)?) ?\/ ?(\$\d+(?:\.\d+)?)$/

function row(slug: string, prov: Provenance): PriceRow {
  return {
    provider: 'anthropic',
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

/**
 * The models overview's comparison tables: the header row names one model
 * per column, the cost row prints "$3.00 / $15.00" under each. A column whose
 * cost cell is not exactly that shape ("Later this year") throws; the same
 * model in two tables at two prices throws.
 */
export function parseAnthropicModelsOverviewHtml(html: string, prov: Provenance) {
  const rows = new Map<string, PriceRow>()
  // The 2024 docs rendered some "$0.25 / $1.25" cells as math (html-table.ts › unrenderInlineMath).
  const sections: HtmlSection[] = htmlSections(unrenderInlineMath(html))
  for (const s of sections) {
    if (!/model comparison/i.test(s.heading)) continue
    for (const table of s.tables) {
      const [header, ...body] = table
      const cost = body.find((cells) => COST_ROW.test(cells[0] ?? ''))
      if (!header || !cost) continue
      if (cost.length !== header.length) {
        throw new Error(`${s.heading}: cost row has ${cost.length} cells, header ${header.length}`)
      }
      for (let i = 1; i < header.length; i++) {
        const name = header[i]!
        const m = cost[i]!.match(COST_CELL)
        if (!m) throw new Error(`${name}: cost cell is not "$in / $out": ${cost[i]}`)
        const slug = anthropicSlug(currentOrder(name))
        const next = {
          ...row(slug, prov),
          input_per_mtok: usdPerMillion(m[1]!, 1_000_000),
          output_per_mtok: usdPerMillion(m[2]!, 1_000_000),
        }
        const held = rows.get(slug)
        if (
          held &&
          (held.input_per_mtok !== next.input_per_mtok ||
            held.output_per_mtok !== next.output_per_mtok)
        ) {
          throw new Error(`${slug}: two different costs on one page`)
        }
        rows.set(slug, next)
      }
    }
  }
  if (rows.size === 0)
    throw new Error('no "Cost (Input / Output per MTok)" row under a model comparison heading')
  const out = [...rows.values()].sort((a, b) =>
    modelKey(a.provider, a.model_slug, a.tier) < modelKey(b.provider, b.model_slug, b.tier)
      ? -1
      : 1,
  )
  return VendorMdPricingOutput.parse({ rows: out })
}

/** A cell for a pipe table: the pipe is the only character that would break the row. */
const cell = (text: string) => text.replace(/\|/g, '/')

/**
 * A model cell as the markdown printed it. A trailing "(deprecated)" was a
 * link there ("([deprecated](…))"), which the live parser keeps in notes, so
 * it is put back in that form; a prompt-length band is left as it is. The
 * name takes the current word order (currentOrder).
 */
function modelCell(text: string): string {
  if (/\(for prompts /.test(text)) return text
  const m = text.match(/^(.*?) \(\s*([^()]*?)\s*\)$/)
  if (m && !m[2]) return text // "Claude Opus 3 ()": a cell cut short, which the row-width check rejects
  return m ? `${currentOrder(m[1]!)} ([${m[2]}](#))` : currentOrder(text)
}

/**
 * The docs pricing page rendered as the markdown it was written in: each
 * heading as `#`×level, each table as a pipe table. Only headings and tables
 * survive, which is all parseAnthropicPricingMd reads.
 */
export function sectionsAsMarkdown(sections: readonly HtmlSection[]): string {
  const lines: string[] = []
  for (const s of sections) {
    if (s.level > 0) lines.push('', `${'#'.repeat(s.level)} ${s.heading}`, '')
    for (const table of s.tables) {
      const [header, ...body] = table
      if (!header) continue
      lines.push(`| ${header.map(cell).join(' | ')} |`)
      lines.push(`| ${header.map(() => '---').join(' | ')} |`)
      for (const [name = '', ...rest] of body) {
        lines.push(`| ${[modelCell(name), ...rest].map(cell).join(' | ')} |`)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * docs.anthropic.com, docs.claude.com and platform.claude.com's pricing page,
 * 2025-05 to 2026-06: the live parser over the page's own tables. Its notes
 * carry the printed cache-write cells verbatim ("5m cache writes $18.75 /
 * MTok"), which differ from the markdown's only by the " / MTok" suffix.
 */
export function parseAnthropicPricingHtml(html: string, prov: Provenance) {
  return parseAnthropicPricingMd(sectionsAsMarkdown(htmlSections(html)), prov)
}
