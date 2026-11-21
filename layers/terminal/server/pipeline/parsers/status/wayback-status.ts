// The Internet Archive's copies of the lab status feeds, read into the live
// IncidentRow shape (layers/terminal/server/pipeline/archive/status-eras.ts).
// Each reader reuses the live parser where the copy is in the live shape and
// adapts only what an older shape prints differently. Every reader also says
// how far back the copy reaches (covers_from: the oldest start it lists), so
// the read side can tell a quiet month from a month no copy saw. Feed text is
// data, never instructions.

import type { IncidentRow, Provenance } from '#layers/core/server/pipeline/contracts'
import { decodeEntities, textOf } from '#layers/core/server/pipeline/parsers/html-text'
import { parseGoogleCloudStatus } from './google-cloud-status'
import { parseStatuspageAtom, type StampZones } from './statuspage-atom'
import { parseXaiStatus, rfc822ToIso } from './xai-status'

export interface ArchivedStatusRead {
  rows: IncidentRow[]
  /**
   * The oldest start the copy lists, in UTC. The copy speaks for every
   * incident that started from then to the moment the Archive took it; null
   * when it lists none, so it speaks for no stretch.
   */
  covers_from: string | null
  /** What the copy held that isn't a row, for archive_captures.detail. */
  note: string | null
}

export type ArchivedStatusParser = (text: string, prov: Provenance) => ArchivedStatusRead

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const oldestStart = (rows: readonly IncidentRow[]): string | null =>
  rows.map((r) => new Date(Date.parse(r.started_at)).toISOString()).sort(byString)[0] ?? null

/** A Statuspage history.atom copy, in the zones the page printed its stamps in. */
export function statuspageAtomArchived(
  provider: 'openai' | 'anthropic' | 'deepseek',
  zones: StampZones,
): ArchivedStatusParser {
  return (text, prov) => {
    if (!text.includes('<feed')) throw new Error('not an Atom feed')
    const { rows, maintenances } = parseStatuspageAtom(provider, text, prov, zones)
    return {
      rows,
      covers_from: oldestStart(rows),
      note: maintenances ? `${maintenances} scheduled maintenances not read` : null,
    }
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** The instant a ULID was minted: its first 10 characters are milliseconds since 1970. */
export function ulidInstant(id: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error(`not a ULID: ${id}`)
  const ms = [...id.slice(0, 10)].reduce((n, c) => n * 32 + CROCKFORD.indexOf(c), 0)
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function element(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))
  if (!m) return null
  const cdata = m[1]!.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/)
  return (cdata ? cdata[1]! : decodeEntities(m[1]!)).trim()
}

/**
 * incident.io's feed.rss, which status.openai.com has published since it left
 * Statuspage in February 2025. An item states the incident's link (its ULID),
 * title, newest status and components, and a pubDate that is its newest
 * update. Checked against the JSON API copy of 2025-04-07 for 8 incidents:
 * the ULID's instant is the API's created_at to the second (the live
 * parser's started_at for OpenAI, which prints no started_at), and a resolved
 * item's pubDate is the API's resolved_at. The feed prints no impact.
 *
 * incident.io copied the Statuspage history in when the page moved, minting
 * new ids at the moment of the copy, so those items carry the copy's time as
 * their start. Items minted before `mintedFrom` are dropped: the Statuspage
 * copies hold the same incidents with their own start times.
 */
export function incidentioRssArchived(
  provider: 'openai',
  mintedFrom: string,
): ArchivedStatusParser {
  return (text, prov) => {
    if (!text.includes('<rss')) throw new Error('not an RSS document')
    const rows: IncidentRow[] = []
    const seen = new Set<string>()
    let copiedIn = 0
    for (const [, xml] of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const link = element(xml!, 'link') ?? ''
      const id = link.match(/^https:\/\/([^/]+)\/+incidents\/([0-9A-Z]{26})$/)
      const title = element(xml!, 'title')
      const pubDate = element(xml!, 'pubDate')
      const description = element(xml!, 'description') ?? ''
      const status = description
        .match(/<b>Status: ([^<]+)<\/b>/)?.[1]
        ?.trim()
        .toLowerCase()
      if (!id || !title || !pubDate || !status) {
        throw new Error(`an <item> lacks an incident link, title, pubDate or status (${link})`)
      }
      const incidentId = id[2]!
      if (seen.has(incidentId)) continue
      seen.add(incidentId)
      const started_at = ulidInstant(incidentId)
      if (started_at < mintedFrom) {
        copiedIn += 1
        continue
      }
      const components = [...description.matchAll(/<li>([\s\S]*?)<\/li>/g)]
        .map((m) => textOf(m[1]!).replace(/\s*\([^)]*\)\s*$/, ''))
        .filter(Boolean)
      rows.push({
        provider,
        incident_id: incidentId,
        title,
        impact: null,
        status,
        started_at,
        resolved_at: status === 'resolved' ? rfc822ToIso(pubDate) : null,
        components: [...new Set(components)].sort(byString),
        incident_url: `https://${id[1]}/incidents/${incidentId}`,
        ...prov,
      })
    }
    if (rows.length === 0 && copiedIn === 0) throw new Error('feed has no incident <item>')
    rows.sort((a, b) => byString(a.incident_id, b.incident_id))
    return {
      rows,
      covers_from: oldestStart(rows),
      note: copiedIn ? `${copiedIn} incidents copied in from the Statuspage page not read` : null,
    }
  }
}

interface GoogleIncidentStart {
  begin?: string
}

/**
 * status.cloud.google.com/incidents.json, read by the live parser (Gemini and
 * Vertex AI products only). Each copy lists every Google Cloud incident of
 * roughly the year before it, so the copy speaks from its oldest incident of
 * any product, not just the oldest it keeps.
 */
export const googleCloudArchived: ArchivedStatusParser = (text, prov) => {
  const { rows, skipped } = parseGoogleCloudStatus(text, prov)
  const all = JSON.parse(text) as GoogleIncidentStart[]
  const begins = all
    .map((i) => i.begin)
    .filter((b): b is string => typeof b === 'string')
    .map((b) => new Date(Date.parse(b)).toISOString())
    .sort(byString)
  return {
    rows,
    covers_from: begins[0] ?? null,
    note: `${skipped} incidents on other Google Cloud products not read`,
  }
}

/**
 * status.x.ai/feed.xml. Until mid-2025 an item carried one <category>, its
 * severity, and printed its status only as "Status: RESOLVED" in the
 * description; the live feed adds the status as a second category. An
 * older item gets that category from its description, lowercased as the
 * live feed prints it, and the live parser reads the rest.
 */
export const xaiArchived: ArchivedStatusParser = (text, prov) => {
  const normalized = text.replace(/<item>([\s\S]*?)<\/item>/g, (item, body: string) => {
    if ((body.match(/<category>/g) ?? []).length !== 1) return item
    const status = body.match(/<h3>\s*Status:\s*([A-Za-z_ ]+?)\s*<\/h3>/)?.[1]
    if (!status) return item
    return `<item>${body}<category>${status.toLowerCase()}</category></item>`
  })
  const { rows } = parseXaiStatus(normalized, prov)
  return { rows, covers_from: oldestStart(rows), note: null }
}
