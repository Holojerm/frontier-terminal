import {
  DisclosureIndexOutput,
  registerParser,
  type DisclosureRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { decodeEntities, textOf } from './html-text'

// openai-misalignment-reports — https://alignment.openai.com/misalignment-reports/
//
// Deterministic parse of a server-rendered page. Reports and notices are one
// `<tbody class="report-entry" id="report-<slug>">` / `id="notice-<id>"` each,
// holding a title row and a description row:
//
//   report  <a class="report-title" href="/misalignment-reports/<slug>/">title</a>
//           <td data-label="Last updated"><time datetime="YYYY-MM-DD">
//           <a class="description-content" href="…"><p>observation</p>
//             <p class="report-topics">Model · Observed-during context</p>
//             <p class="report-topics">Topic · Topic</p></a>
//   notice  <a class="report-title" href="https://openai.com/…">title</a>
//           <td data-label="First posted"><time datetime="YYYY-MM-DD">
//           <a class="description-content" href="https://openai.com/…"><p>summary</p></a>
//
// Both `report-topics` paragraphs share a class; the topics one is told apart
// by matching the tbody's `data-topics` JSON, and what is left is the model
// line (absent on a report that prints none).
//
// The page has been redesigned twice: before 2026-10-03 a report carried a
// `cb-meta` line and a Model / Observed during `<dl>`; until 2026-10-07 it was
// a list of `<details class="cb-entry">`; it is now a sortable table. Each time
// every entry parsed as "unrecognised" and the source failed.
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

const ENTRY = /<tbody class="([^"]*)" id="([^"]*)"([^>]*)>([\s\S]*?)<\/tbody>/g
const REPORT_PATH = /^\/misalignment-reports\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/
const INDEX_CONTAINER = /class="cb-index"/
// "Highly persistent internal model · Internal deployment": model, then the
// context it was observed in. Split on the last separator.
const MODEL_SEPARATOR = ' · '

const first = (html: string, re: RegExp): string | null => html.match(re)?.[1] ?? null

/** The ISO date in the `<time>` of the cell labelled `label`. */
function dateCell(body: string, label: string): string | null {
  return first(
    body,
    new RegExp(`<td [^>]*data-label="${label}"[^>]*>\\s*<time datetime="(\\d{4}-\\d{2}-\\d{2})"`),
  )
}

/** The topics line the page prints under a report ("Compaction behavior · Concealment"),
 * rebuilt from the tbody's `data-topics` JSON so it can be told from the model line. */
function topicsLine(attrs: string): string | null {
  const raw = first(attrs, /\bdata-topics="([^"]*)"/)
  if (raw === null) return null
  try {
    const topics: unknown = JSON.parse(decodeEntities(raw))
    return Array.isArray(topics) && topics.every((t) => typeof t === 'string')
      ? topics.join(MODEL_SEPARATOR)
      : null
  } catch {
    return null
  }
}

export function parseOpenAiMisalignmentReports(
  html: string,
  prov: Provenance = fixtureProvenance('openai-misalignment-reports'),
): MisalignmentIndexResult {
  const rows: DisclosureRow[] = []
  const skipped: SkippedEntry[] = []
  let entries = 0

  for (const [, classAttr, id, attrs, body] of html.matchAll(ENTRY)) {
    if (!classAttr!.split(/\s+/).includes('report-entry')) continue
    entries++

    const title = textOf(first(body!, /<a class="report-title"[^>]*>([\s\S]*?)<\/a>/) ?? '')
    const isNotice = id!.startsWith('notice-')
    // Reports are listed by their last update, notices by when they were posted.
    const listedOn = dateCell(body!, isNotice ? 'First posted' : 'Last updated')
    const description = body!.match(
      /<a class="description-content" href="([^"]+)"[^>]*>\s*<p>([\s\S]*?)<\/p>/,
    )
    const summary = description ? textOf(description[2]!) : ''
    const name = title || `(untitled entry ${entries})`
    if (!title || !listedOn || !summary) {
      skipped.push({ entry: name, reason: 'no title, dated line or summary' })
      continue
    }

    if (isNotice) {
      const noticeId = first(id!, /^notice-([a-z0-9]+(?:-[a-z0-9]+)*)$/)
      const href = first(body!, /<a class="report-title" href="([^"]+)"/)
      if (!noticeId || !href) {
        skipped.push({ entry: name, reason: 'notice without an id or an update link' })
        continue
      }
      rows.push({
        provider: 'openai',
        kind: 'notice',
        entry_id: noticeId,
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

    const href = first(body!, /<a class="report-title" href="([^"]+)"/)
    const slug = href ? first(href, REPORT_PATH) : null
    if (!href || !slug) {
      skipped.push({
        entry: name,
        reason: `report link is not /misalignment-reports/<slug>/: ${href}`,
      })
      continue
    }
    const topics = topicsLine(attrs!)
    const modelLine =
      [...body!.matchAll(/<p class="report-topics">([\s\S]*?)<\/p>/g)]
        .map((m) => textOf(m[1]!))
        .find((line) => line !== topics) ?? ''
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
    throw new Error('misalignment index has no <tbody class="report-entry"> entries')
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
