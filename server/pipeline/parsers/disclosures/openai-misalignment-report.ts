import {
  DisclosureReportPageOutput,
  registerParser,
  type DisclosureTimelineRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { printedDate, textOf } from './html-text'

// openai-misalignment-report-<slug> —
// https://alignment.openai.com/misalignment-reports/<slug>/
//
// One page per report listed on the index, derived from the stored index
// rows (server/pipeline/derived.ts). The page opens with a metadata cell —
// the first `<table class="ap-doc-table">` inside `<article class="ap-doc">`
// — whose paragraphs read:
//
//   Internal research model · RL training        (scope: the index has it)
//   Sample: Sep 20, 2026                         (occurrence: verbatim only)
//   Discovery: Sep 20, 2026                      (discovered_on)
//   Disclosure date: Sep 25, 2026                (disclosed_on; one page of nine)
//   Report updated: Sep 25, 2026                 (dropped: the index has it)
//
// Two page layouts exist and both put the cell there. Labels vary between
// reports, so the discovery date is read under every label the vendor has
// used, and only when the value is exactly one date. The page does not
// print its own slug, so the row carries the page's title and the read side
// joins it to the index entry only when the titles agree.

const DISCOVERY_LABELS = new Set(['discovery', 'discovered', 'discovery date'])
const DISCLOSURE_LABELS = new Set(['disclosure date'])
const DROPPED_LABELS = new Set(['report updated'])
const LINE = /^([A-Z][A-Za-z ]{0,39}):\s*(\S.*)$/

export function parseOpenAiMisalignmentReport(
  html: string,
  entryId: string | null,
  prov: Provenance = fixtureProvenance(
    'openai-misalignment-report-an-agent-used-dns-to-reach-an-external-chatbot',
  ),
) {
  if (entryId === null)
    throw new Error('a report page is only parsed for the slug it was derived for')
  const article = html.match(/<article class="ap-doc" aria-label="([^"]+)">([\s\S]*?)<\/article>/)
  if (!article) throw new Error('report page has no <article class="ap-doc">')
  const title = textOf(article[1]!)
  const table = article[2]!.match(/<table class="ap-doc-table"[^>]*>([\s\S]*?)<\/table>/)
  const cell = table?.[1]!.match(/<td[^>]*>([\s\S]*?)<\/td>/)?.[1]
  if (!cell) throw new Error('report page has no metadata cell')

  const lines: DisclosureTimelineRow['lines'] = []
  let discovered: string | null = null
  let disclosed: string | null = null
  for (const [, inner] of cell.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const m = textOf(inner!).match(LINE)
    if (!m) continue // the scope line, or a blank paragraph
    const label = m[1]!.trim()
    const value = m[2]!.trim()
    const key = label.toLowerCase()
    if (DROPPED_LABELS.has(key)) continue
    lines.push({ label, value })
    if (DISCOVERY_LABELS.has(key)) discovered = pick(discovered, printedDate(value), label)
    if (DISCLOSURE_LABELS.has(key)) disclosed = pick(disclosed, printedDate(value), label)
  }
  if (lines.length === 0) throw new Error('report page metadata cell has no "Label: value" line')

  return DisclosureReportPageOutput.parse({
    rows: [
      {
        provider: 'openai',
        entry_id: entryId,
        title,
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
