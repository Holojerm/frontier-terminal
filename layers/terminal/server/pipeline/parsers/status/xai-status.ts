import {
  XaiStatusIncidentsOutput,
  registerParser,
  type IncidentRow,
  type Provenance,
} from '../../contracts'
import { decodeEntities } from '../disclosures/html-text'
import { fixtureProvenance } from '../fixture-provenance'

// xai-status — status.x.ai/feed.xml, the RSS history the status page
// publishes ("Incident history for xAI services."). Its JSON API and HTML
// pages answer 403 to a headless client and robots.txt disallows /api/; the
// feed answers 200 and robots.txt allows it.
//
// The feed posts one <item> per affected component: the title is
// "[Component] Incident name", the guid is the incident id shared by every
// component's item, and the categories are severity then status
// ("disruption", "resolved"). Items are folded to one row per guid with the
// components listed, as a Statuspage incident lists its components.
// pubDate is the incident's stated start; "Resolved: <date>" in the
// description is its end. Feed text is data.

const ITEM = /<item>([\s\S]*?)<\/item>/g
const COMPONENT_TITLE = /^\[([^\]]+)\] ([\s\S]+)$/

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** RFC 822 "Tue, 03 Nov 2026 21:40:43 GMT" as "2026-11-03T21:40:43Z". Anything else throws. */
export function rfc822ToIso(stamp: string): string {
  const m = stamp
    .trim()
    .match(/^[A-Z][a-z]{2}, (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/)
  const month = m ? MONTHS.indexOf(m[2]!) : -1
  if (!m || month === -1) throw new Error(`xai-status: unparseable date: ${stamp}`)
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1]}T${m[4]}Z`
}

function field(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))
  return m ? m[1]! : null
}

/** An element's text: a CDATA section as is, anything else with XML entities decoded once. */
function text(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/)
  return (cdata ? cdata[1]! : decodeEntities(raw)).trim()
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

interface Item {
  guid: string
  component: string
  title: string
  link: string
  started_at: string
  resolved_at: string | null
  impact: string
  status: string
}

function readItem(xml: string): Item {
  const guid = text(field(xml, 'guid') ?? '')
  const heading = text(field(xml, 'title') ?? '')
  const titled = heading.match(COMPONENT_TITLE)
  const categories = [...xml.matchAll(/<category>([\s\S]*?)<\/category>/g)].map((m) => text(m[1]!))
  const pubDate = field(xml, 'pubDate')
  const link = text(field(xml, 'link') ?? '')
  if (!guid || !titled || !pubDate || !link || categories.length < 2) {
    throw new Error(
      `xai-status: an <item> lacks guid, "[Component] title", pubDate, link or two categories (${guid || '?'})`,
    )
  }
  const resolved = text(field(xml, 'description') ?? '').match(/Resolved: ([^<]+)</)
  return {
    guid,
    component: titled[1]!,
    title: titled[2]!,
    link,
    started_at: rfc822ToIso(text(pubDate)),
    resolved_at: resolved ? rfc822ToIso(resolved[1]!) : null,
    impact: categories[0]!,
    status: categories[1]!,
  }
}

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseXaiStatus(text: string, prov: Provenance = fixtureProvenance('xai-status')) {
  if (!text.includes('<rss')) throw new Error('xai-status: not an RSS document')
  const byGuid = new Map<string, Item[]>()
  for (const [, xml] of text.matchAll(ITEM)) {
    const item = readItem(xml!)
    byGuid.set(item.guid, [...(byGuid.get(item.guid) ?? []), item])
  }
  const rows: IncidentRow[] = []
  for (const [guid, items] of byGuid) {
    // Every component's item restates the same incident; if they disagree the
    // fold would pick one silently, so the feed's shape has changed: fail.
    const first = items[0]!
    for (const other of items) {
      if (
        other.title !== first.title ||
        other.started_at !== first.started_at ||
        other.resolved_at !== first.resolved_at ||
        other.impact !== first.impact ||
        other.status !== first.status
      ) {
        throw new Error(`xai-status: incident ${guid} differs between its component items`)
      }
    }
    const byComponent = [...items].sort((a, b) => byString(a.component, b.component))
    rows.push({
      provider: 'xai',
      incident_id: guid,
      title: first.title,
      impact: first.impact,
      status: first.status,
      started_at: first.started_at,
      resolved_at: first.resolved_at,
      components: [...new Set(byComponent.map((i) => i.component))],
      // Each component's item links its own page; the first by name is kept.
      incident_url: byComponent[0]!.link,
      ...prov,
    })
  }
  rows.sort((a, b) => byString(a.incident_id, b.incident_id))
  return XaiStatusIncidentsOutput.parse({ rows })
}

registerParser({
  name: 'xai-status',
  lane: 'status',
  fixturePath: 'fixtures/status/xai-status.xml',
  sideFixturePaths: [],
  schema: XaiStatusIncidentsOutput,
  parse: (text) => parseXaiStatus(text),
})
