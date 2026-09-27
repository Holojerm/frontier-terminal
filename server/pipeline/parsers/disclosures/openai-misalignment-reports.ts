import {
  DisclosureIndexOutput,
  registerParser,
  type DisclosureRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { textOf } from './html-text'

// openai-misalignment-reports — https://alignment.openai.com/misalignment-reports/
//
// Deterministic parse of a server-rendered page: one
// `<details class="cb-entry">` per report and one
// `<details class="cb-entry cb-notice" id="notice-<id>">` per notice.
//
//   report  <h3>title</h3>
//           <p class="cb-meta">Report · Updated <time datetime="YYYY-MM-DD">…
//           <p class="cb-copy">observation</p>
//           <a class="cb-link" href="/misalignment-reports/<slug>/">
//           <dl> Model / Observed during / Report updated </dl>
//   notice  <h3>title</h3>
//           <p class="cb-meta">Notice · <time datetime="YYYY-MM-DD">…
//           <p class="cb-copy">summary</p>
//           <a class="ap-notice-source" href="https://openai.com/…">
//
// Honesty rules:
//   1. Every string a reader sees is the page's own text, verbatim.
//   2. An entry whose structure is not recognised is reported in `skipped`,
//      never dropped silently; a page with entries but no recognised report
//      throws, so a redesign fails the source instead of emptying it.
//   3. A <dl> label this parser does not know is reported in `skipped` too.
//   4. Provenance is an argument. Nothing here reads a clock.

export interface SkippedEntry {
  entry: string
  reason: string
}

export interface MisalignmentIndexResult {
  rows: DisclosureRow[]
  skipped: SkippedEntry[]
}

const ENTRY = /<details class="([^"]*)"([^>]*)>([\s\S]*?)<\/details>/g
const REPORT_PATH = /^\/misalignment-reports\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/
const KNOWN_REPORT_LABELS = new Set(['Model', 'Observed during', 'Report updated'])

const first = (html: string, re: RegExp): string | null => html.match(re)?.[1] ?? null

export function parseOpenAiMisalignmentReports(
  html: string,
  prov: Provenance = fixtureProvenance('openai-misalignment-reports'),
): MisalignmentIndexResult {
  const rows: DisclosureRow[] = []
  const skipped: SkippedEntry[] = []
  let entries = 0

  for (const [, classAttr, attrs, body] of html.matchAll(ENTRY)) {
    const classes = classAttr!.split(/\s+/)
    if (!classes.includes('cb-entry')) continue
    entries++

    const titleHtml = first(body!, /<h3>([\s\S]*?)<\/h3>/)
    const title = titleHtml === null ? '' : textOf(titleHtml)
    const listedOn = first(body!, /<p class="cb-meta">[\s\S]*?<time datetime="(\d{4}-\d{2}-\d{2})"/)
    const summaryHtml = first(body!, /<p class="cb-copy">([\s\S]*?)<\/p>/)
    const summary = summaryHtml === null ? '' : textOf(summaryHtml)
    const name = title || `(untitled entry ${entries})`
    if (!title || !listedOn || !summary) {
      skipped.push({ entry: name, reason: 'no title, dated meta line or summary' })
      continue
    }

    if (classes.includes('cb-notice')) {
      const id = first(attrs!, /\bid="notice-([a-z0-9]+(?:-[a-z0-9]+)*)"/)
      const href = first(body!, /<a class="ap-notice-source" href="([^"]+)"/)
      if (!id || !href) {
        skipped.push({ entry: name, reason: 'notice without an id or an update link' })
        continue
      }
      rows.push({
        provider: 'openai',
        kind: 'notice',
        entry_id: id,
        title,
        summary,
        model: null,
        observed_during: null,
        listed_on: listedOn,
        entry_url: new URL(href, prov.source_url).href,
        ...prov,
      })
      continue
    }

    const href = first(body!, /<a class="cb-link" href="([^"]+)"/)
    const slug = href ? first(href, REPORT_PATH) : null
    if (!href || !slug) {
      skipped.push({
        entry: name,
        reason: `report link is not /misalignment-reports/<slug>/: ${href}`,
      })
      continue
    }
    const fields = new Map<string, string>()
    for (const [, dt, dd] of body!.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
      const label = textOf(dt!)
      if (!KNOWN_REPORT_LABELS.has(label)) {
        skipped.push({ entry: name, reason: `unrecognised field "${label}" not stored` })
        continue
      }
      fields.set(label, textOf(dd!))
    }
    rows.push({
      provider: 'openai',
      kind: 'report',
      entry_id: slug,
      title,
      summary,
      model: fields.get('Model') || null,
      observed_during: fields.get('Observed during') || null,
      listed_on: listedOn,
      entry_url: new URL(href, prov.source_url).href,
      ...prov,
    })
  }

  if (entries === 0) throw new Error('misalignment index has no <details class="cb-entry"> entries')
  if (!rows.some((r) => r.kind === 'report')) {
    throw new Error(`misalignment index: none of ${entries} entries parsed as a report`)
  }
  const out = DisclosureIndexOutput.parse({ rows })
  return { rows: out.rows, skipped }
}

registerParser({
  name: 'openai-misalignment-reports',
  lane: 'disclosures',
  fixturePath: 'fixtures/disclosures/openai-misalignment-reports.html',
  sideFixturePaths: [],
  schema: DisclosureIndexOutput,
  parse: (html) => DisclosureIndexOutput.parse({ rows: parseOpenAiMisalignmentReports(html).rows }),
})
