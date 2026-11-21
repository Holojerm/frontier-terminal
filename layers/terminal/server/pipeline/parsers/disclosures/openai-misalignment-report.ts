import {
  DisclosureReportPageOutput,
  registerParser,
  type DisclosureTimelineRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { printedDate, textOf } from './html-text'

// openai-misalignment-report-<slug> —
// https://openai.com/safety-alignment/misalignment-reports/<slug>/
//
// One page per report listed on the index, derived from the stored index
// rows (layers/terminal/server/pipeline/derived.ts). The title is the page's
// `<h1>`; under it a `<div data-safety-report-metadata>` block holds one
// paragraph per line:
//
//   <strong>Internal research model · RL training</strong>   (model · observed during)
//   Discovery: Sep 20, 2026                      (discovered_on)
//   Incident date: Sep 20, 2026                  (occurrence: verbatim only)
//   First posted: Sep 25, 2026                   (disclosed_on)
//   Last updated: Sep 25, 2026                   (dropped: the index has it)
//
// Labels vary between reports ("Discovered", "Discovery date"; "Disclosure
// date" where "First posted" would be; "Report updated" for "Last updated"),
// so each date is read under every label the vendor has used, and only when
// the value is exactly one date. The page does not print its own slug, so
// the row carries the page's title and the read side joins it to the index
// entry only when the titles agree. Until 2026-11-20 the page was an
// `<article class="ap-doc">` on alignment.openai.com and the model line was
// on the index instead.

const DISCOVERY_LABELS = new Set(['discovery', 'discovered', 'discovery date'])
const DISCLOSURE_LABELS = new Set(['disclosure date', 'first posted'])
const DROPPED_LABELS = new Set(['report updated', 'last updated'])
const LINE = /^([A-Z][A-Za-z ]{0,39}):\s*(\S.*)$/
const METADATA = '<div data-safety-report-metadata'
// "Highly persistent internal model · Internal deployment": model, then the
// context it was observed in. Split on the last separator.
const MODEL_SEPARATOR = ' · '

export function parseOpenAiMisalignmentReport(
  html: string,
  entryId: string | null,
  prov: Provenance = fixtureProvenance(
    'openai-misalignment-report-an-agent-used-dns-to-reach-an-external-chatbot',
  ),
) {
  if (entryId === null)
    throw new Error('a report page is only parsed for the slug it was derived for')
  const start = html.indexOf(METADATA)
  if (start === -1) throw new Error(`report page has no ${METADATA}>`)
  const title = textOf(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '')
  if (!title) throw new Error('report page has no <h1> title')
  // The block holds only divs and paragraphs; the report's first heading closes it.
  const rest = html.slice(start)
  const end = rest.search(/<h[1-6][\s>]/)
  const block = end === -1 ? rest : rest.slice(0, end)

  const lines: DisclosureTimelineRow['lines'] = []
  let scope: string | null = null
  let discovered: string | null = null
  let disclosed: string | null = null
  for (const [, inner] of block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const strong = inner!.match(/^\s*<strong>([\s\S]*?)<\/strong>\s*$/)
    if (strong && scope === null && lines.length === 0) {
      scope = textOf(strong[1]!) || null
      continue
    }
    const m = textOf(inner!).match(LINE)
    if (!m) continue // a blank paragraph
    const label = m[1]!.trim()
    const value = m[2]!.trim()
    const key = label.toLowerCase()
    if (DROPPED_LABELS.has(key)) continue
    lines.push({ label, value })
    if (DISCOVERY_LABELS.has(key)) discovered = pick(discovered, printedDate(value), label)
    if (DISCLOSURE_LABELS.has(key)) disclosed = pick(disclosed, printedDate(value), label)
  }
  if (lines.length === 0) throw new Error('report page metadata has no "Label: value" line')

  const cut = scope?.lastIndexOf(MODEL_SEPARATOR) ?? -1
  return DisclosureReportPageOutput.parse({
    rows: [
      {
        provider: 'openai',
        entry_id: entryId,
        title,
        model: (cut === -1 ? scope : scope!.slice(0, cut)) || null,
        observed_during: cut === -1 ? null : scope!.slice(cut + MODEL_SEPARATOR.length) || null,
        lines,
        discovered_on: discovered,
        disclosed_on: disclosed,
        ...prov,
      },
    ],
  })
}

/** Two lines for the same date that disagree are a page this parser does not understand. */
function pick(current: string | null, next: string | null, label: string): string | null {
  if (current !== null && next !== null && current !== next) {
    throw new Error(`report page prints two different "${label}" dates: ${current}, ${next}`)
  }
  return current ?? next
}

registerParser({
  name: 'openai-misalignment-report-an-agent-used-dns-to-reach-an-external-chatbot',
  lane: 'disclosures',
  fixturePath:
    'fixtures/disclosures/openai-misalignment-report-an-agent-used-dns-to-reach-an-external-chatbot.html',
  sideFixturePaths: [],
  schema: DisclosureReportPageOutput,
  parse: (html) =>
    parseOpenAiMisalignmentReport(html, 'an-agent-used-dns-to-reach-an-external-chatbot'),
})
