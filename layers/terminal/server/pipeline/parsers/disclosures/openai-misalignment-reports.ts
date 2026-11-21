import {
  DisclosureIndexOutput,
  registerParser,
  type DisclosureRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'

// openai-misalignment-reports — https://openai.com/safety-alignment/misalignment-reports/
//
// Deterministic parse of a server-rendered Next.js page. The HTML lists the
// first 20 entries behind a "Load more" button; every entry is in the page's
// flight payload (the `self.__next_f.push([1,"…"])` script strings), as one
// `"items":[…]` array:
//
//   {"title": "…", "href": "/safety-alignment/misalignment-reports/<slug>/",
//    "description": "…", "date": "YYYY-MM-DD",
//    "reportDates": {"incidents": […], "discovered": […],
//                    "firstPosted": "YYYY-MM-DD", "lastUpdated": "YYYY-MM-DD"},
//    "filters": {"type": ["reports"] | ["notices"], "category": […], …}}
//
// A notice's href is an absolute openai.com update link. The index no longer
// prints a report's model or the context it was observed in; the report's own
// page does (openai-misalignment-report.ts), so both are null here.
//
// The page has been redesigned four times: a `cb-meta` line until 2026-10-03,
// `<details class="cb-entry">` until 2026-10-07, a `<tbody class="report-entry">`
// table on alignment.openai.com until 2026-11-20, then this page on openai.com
// (the old host answers 308 to it). Each time every entry failed to parse and
// the source failed.
//
// Honesty rules:
//   1. Every string a reader sees is the page's own text, verbatim.
//   2. An entry whose structure is not recognised is reported in `skipped`,
//      never dropped silently; a page with entries but no recognised report
//      throws, so a redesign fails the source instead of emptying it.
//   3. A page whose items array is empty is an empty index (no disclosures
//      yet), not a failure.
//   4. Provenance is an argument. Nothing here reads a clock.

export interface SkippedEntry {
  entry: string
  reason: string
}

export interface MisalignmentIndexResult {
  rows: DisclosureRow[]
  skipped: SkippedEntry[]
}

const FLIGHT_CHUNK = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g
const ITEMS = '"items":['
const REPORT_PATH = /^\/safety-alignment\/misalignment-reports\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/
const ISO = /^\d{4}-\d{2}-\d{2}$/

/** The flight payload: every script string, decoded and joined in page order. */
function flightOf(html: string): string {
  return [...html.matchAll(FLIGHT_CHUNK)].map((m) => JSON.parse(`"${m[1]}"`) as string).join('')
}

/** The JSON array that opens at `start` (a '['), or null when it never closes. */
function arrayAt(text: string, start: number): unknown[] | null {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      if (--depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, i + 1))
          return Array.isArray(value) ? value : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Every `"items":[…]` array whose entries are disclosure entries (they carry `reportDates`). */
function itemsOf(flight: string): Record<string, unknown>[] | null {
  for (let at = flight.indexOf(ITEMS); at !== -1; at = flight.indexOf(ITEMS, at + 1)) {
    const items = arrayAt(flight, at + ITEMS.length - 1)
    if (!items) continue
    const entries = items.filter(
      (i): i is Record<string, unknown> => typeof i === 'object' && i !== null,
    )
    if (entries.length === items.length && entries.every((i) => 'reportDates' in i)) return entries
  }
  return null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const isoOf = (v: unknown): string | null => (typeof v === 'string' && ISO.test(v) ? v : null)

/** A notice's id is its title as a slug ("Hugging Face" → hugging-face), as the old index printed it. */
const noticeId = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** The index's entries as the page's payload holds them, or null when it holds none. */
export const misalignmentIndexItems = (html: string) => itemsOf(flightOf(html))

export function parseOpenAiMisalignmentReports(
  html: string,
  prov: Provenance = fixtureProvenance('openai-misalignment-reports'),
): MisalignmentIndexResult {
  const items = misalignmentIndexItems(html)
  if (!items) throw new Error('misalignment index has no "items" payload of reports and notices')

  const rows: DisclosureRow[] = []
  const skipped: SkippedEntry[] = []
  items.forEach((item, n) => {
    const title = text(item.title)
    const summary = text(item.description)
    const href = text(item.href)
    const type = (item.filters as { type?: unknown } | undefined)?.type
    const dates = (item.reportDates ?? {}) as Record<string, unknown>
    const name = title || `(untitled entry ${n + 1})`
    const kind = Array.isArray(type) && type.length === 1 ? type[0] : null
    if (kind !== 'reports' && kind !== 'notices') {
      skipped.push({
        entry: name,
        reason: `type is not reports or notices: ${JSON.stringify(type)}`,
      })
      return
    }
    const isNotice = kind === 'notices'
    // Reports are listed by their last update, notices by when they were posted.
    const listedOn = isoOf(isNotice ? dates.firstPosted : dates.lastUpdated)
    if (!title || !summary || !href || !listedOn) {
      skipped.push({ entry: name, reason: 'no title, summary, link or dated line' })
      return
    }

    if (isNotice) {
      const id = noticeId(title)
      if (!id) {
        skipped.push({ entry: name, reason: 'notice title gives no id' })
        return
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
      return
    }

    const slug = href.match(REPORT_PATH)?.[1]
    if (!slug) {
      skipped.push({
        entry: name,
        reason: `report link is not /safety-alignment/misalignment-reports/<slug>/: ${href}`,
      })
      return
    }
    rows.push({
      provider: 'openai',
      kind: 'report',
      entry_id: slug,
      title,
      summary,
      model: null,
      observed_during: null,
      listed_on: listedOn,
      entry_url: new URL(href, prov.source_url).href,
      ...prov,
    })
  })

  if (items.length > 0 && !rows.some((r) => r.kind === 'report')) {
    throw new Error(`misalignment index: none of ${items.length} entries parsed as a report`)
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
