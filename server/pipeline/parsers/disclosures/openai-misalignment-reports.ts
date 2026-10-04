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
//           <div class="cb-updated">Report updated <time datetime="YYYY-MM-DD">…
//           <p class="cb-model">Model · Observed-during context</p>
//           <p class="cb-copy">observation</p>
//           <a class="cb-link" href="/misalignment-reports/<slug>/">
//   notice  <h3>title</h3>
//           <p class="cb-meta">Notice · <time datetime="YYYY-MM-DD">…
//           <p class="cb-copy">summary</p>
//           <a class="ap-notice-source" href="https://openai.com/…">
//
// Before 2026-10-03 a report carried a `cb-meta` line and a Model / Observed
// during `<dl>` instead; the page dropped both and every report parsed as
// "unrecognised", which is how the source failed for a day.
//
// Honesty rules:
//   1. Every string a reader sees is the page's own text, verbatim.
//   2. An entry whose structure is not recognised is reported in `skipped`,
//      never dropped silently; a page with entries but no recognised report
//      throws, so a redesign fails the source instead of emptying it.
//   3. A page that has the index container but no entries at all is an empty
//      index (no disclosures yet), not a failure.
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
const INDEX_CONTAINER = /class="cb-index"/
// "Highly persistent internal model · Internal deployment": model, then the
// context it was observed in. Split on the last separator.
const MODEL_SEPARATOR = ' · '

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
    const listedOn = first(
      body!,
      /<(?:p|div) class="cb-(?:updated|meta)">[^<]*<time datetime="(\d{4}-\d{2}-\d{2})"/,
    )
    const summaryHtml = first(body!, /<p class="cb-copy">([\s\S]*?)<\/p>/)
    const summary = summaryHtml === null ? '' : textOf(summaryHtml)
    const name = title || `(untitled entry ${entries})`
    if (!title || !listedOn || !summary) {
      skipped.push({ entry: name, reason: 'no title, dated line or summary' })
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
    const modelLine = textOf(first(body!, /<p class="cb-model">([\s\S]*?)<\/p>/) ?? '')
    const cut = modelLine.lastIndexOf(MODEL_SEPARATOR)
    const model = (cut === -1 ? modelLine : modelLine.slice(0, cut)) || null
    const observedDuring = cut === -1 ? null : modelLine.slice(cut + MODEL_SEPARATOR.length) || null
    rows.push({
      provider: 'openai',
      kind: 'report',
      entry_id: slug,
      title,
      summary,
      model,
      observed_during: observedDuring,
      listed_on: listedOn,
      entry_url: new URL(href, prov.source_url).href,
      ...prov,
    })
  }

  if (entries === 0) {
    if (INDEX_CONTAINER.test(html)) return { rows, skipped }
    throw new Error('misalignment index has no <details class="cb-entry"> entries')
  }
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
