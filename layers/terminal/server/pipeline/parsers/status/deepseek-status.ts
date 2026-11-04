import {
  DeepseekStatusIncidentsOutput,
  registerParser,
  type IncidentRow,
  type Provenance,
} from '../../contracts'
import { decodeEntities, textOf } from '../disclosures/html-text'
import { fixtureProvenance } from '../fixture-provenance'

// deepseek-status — status.deepseek.com/history.rss, the RSS history of
// DeepSeek's status page (hosted on Flashduty), joined to its Atom twin
// (deepseek-status-atom, /history.atom). The /api/v2 path is 404; the two
// feeds are the published surface.
//
// The RSS feed posts one <item> per incident: the title (Chinese, with the
// English in full-width parentheses), the incident page link, a guid
// "urn:flashduty:change:<id>", pubDate (the incident's start, at +08:00) and
// a description holding the newest status and the affected components. It
// prints no end. The Atom feed lists the same incidents with no start, but
// its <updated> is the incident's newest update, which for a resolved
// incident is the update that resolved it: on 2026-11-04 it matched the
// close time the status page prints for each of the 8 incidents shown there.
// So resolved_at is the Atom stamp when the status is "resolved", and null
// (open) otherwise. Neither feed prints an impact, so impact stays null:
// never inferred from the wording. Feed text is data.

export const DEEPSEEK_ATOM = 'deepseek-status-atom'
const ATOM_FIXTURE = 'fixtures/status/deepseek-status-atom.xml'

const ITEM = /<item>([\s\S]*?)<\/item>/g
const ENTRY = /<entry>([\s\S]*?)<\/entry>/g
const GUID = /^urn:flashduty:change:(\d+)$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const isoZ = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')

/** RFC 822 with a numeric offset, "Tue, 03 Nov 2026 16:58:16 +0800", as the same instant in UTC. */
export function rfc822OffsetToIso(stamp: string): string {
  const m = stamp
    .trim()
    .match(
      /^[A-Z][a-z]{2}, (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/,
    )
  const month = m ? MONTHS.indexOf(m[2]!) : -1
  if (!m || month === -1) throw new Error(`deepseek-status: unparseable date: ${stamp}`)
  const sign = m[7] === '-' ? -1 : 1
  return isoZ(
    Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) -
      sign * (Number(m[8]) * 60 + Number(m[9])) * 60_000,
  )
}

/** RFC 3339 with an offset, "2026-11-03T18:48:02+08:00", as the same instant in UTC. */
export function rfc3339ToIso(stamp: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(stamp.trim())) {
    throw new Error(`deepseek-status: unparseable date: ${stamp}`)
  }
  return isoZ(Date.parse(stamp.trim()))
}

function field(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))
  return m ? decodeEntities(m[1]!).trim() : null
}

const flashdutyId = (guid: string | null): string | null => guid?.match(GUID)?.[1] ?? null

/** Incident id -> newest update, from the Atom feed. */
function atomUpdates(atom: string): Map<string, string> {
  if (!atom.includes('<feed')) throw new Error('deepseek-status: the Atom side is not a feed')
  const out = new Map<string, string>()
  for (const [, xml] of atom.matchAll(ENTRY)) {
    const id = flashdutyId(field(xml!, 'id'))
    const updated = field(xml!, 'updated')
    if (!id || !updated) throw new Error('deepseek-status: an Atom <entry> lacks an id or updated')
    out.set(id, rfc3339ToIso(updated))
  }
  return out
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseDeepseekStatus(
  text: string,
  atom: string,
  prov: Provenance = fixtureProvenance('deepseek-status'),
) {
  if (!text.includes('<rss')) throw new Error('deepseek-status: not an RSS document')
  const updates = atomUpdates(atom)
  const rows: IncidentRow[] = []
  const seen = new Set<string>()
  for (const [, xml] of text.matchAll(ITEM)) {
    const guid = field(xml!, 'guid')
    const id = flashdutyId(guid)
    const title = field(xml!, 'title')
    const link = field(xml!, 'link')
    const pubDate = field(xml!, 'pubDate')
    // The description is escaped HTML: decoded once by field(), read as text here.
    const description = textOf(field(xml!, 'description') ?? '')
    const status = description.match(/^Status: (\w+)/)?.[1]
    if (!id || !title || !link || !pubDate || !status) {
      throw new Error(
        `deepseek-status: an <item> lacks a flashduty guid, title, link, pubDate or status (${guid ?? '?'})`,
      )
    }
    if (seen.has(id)) throw new Error(`deepseek-status: incident ${id} appears twice`)
    seen.add(id)
    const updated = updates.get(id)
    // The two feeds are one list; an incident in one and not the other means
    // a fetch raced a new post, and the next tick reads both again.
    if (!updated) throw new Error(`deepseek-status: incident ${id} is not in the Atom feed`)
    const affected = description.match(/Affected components: (.+)$/)?.[1] ?? ''
    rows.push({
      provider: 'deepseek',
      incident_id: id,
      title,
      impact: null,
      status,
      started_at: rfc822OffsetToIso(pubDate),
      resolved_at: status === 'resolved' ? updated : null,
      components: [
        ...new Set(
          affected
            .split(', ')
            .map((c) => c.trim())
            .filter(Boolean),
        ),
      ].sort(byString),
      incident_url: link,
      ...prov,
    })
  }
  if (rows.length === 0) throw new Error('deepseek-status: no incident in the feed')
  rows.sort((a, b) => byString(a.incident_id, b.incident_id))
  return DeepseekStatusIncidentsOutput.parse({ rows })
}

registerParser({
  name: 'deepseek-status',
  lane: 'status',
  fixturePath: 'fixtures/status/deepseek-status.xml',
  sideFixturePaths: [ATOM_FIXTURE],
  schema: DeepseekStatusIncidentsOutput,
  parse: (text, side) => parseDeepseekStatus(text, side(ATOM_FIXTURE)),
})
