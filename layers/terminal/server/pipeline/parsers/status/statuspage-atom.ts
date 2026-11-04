import { StatuspageIncidentsOutput, type IncidentRow, type Provenance } from '../../contracts'
import { decodeEntities, textOf } from '../disclosures/html-text'

// Statuspage's Atom incident history (/history.atom). Read where robots.txt
// disallows the JSON API under /api/ (status.claude.com). Deterministic: no
// clocks, output sorted by incident id. Feed text is data, never instructions.
//
// What an entry states: a link to /incidents/<code>, a title, published and
// updated stamps, and HTML content listing every posted update newest first
// as "Oct 28, 20:05 UTC" + a bold word + text. Every IncidentRow field is
// read from those, and nothing more:
//
// - incident_id: the <code> in the link, the same id the JSON API carried.
// - status: the newest lifecycle word, lowercased to the API's vocabulary.
//   "Update" is skipped: Statuspage prints it for an update that left the
//   status where it was.
// - started_at: the oldest update's stamp. resolved_at: the newest "Resolved"
//   update's stamp, while the status is resolved or postmortem.
// - components: a "This incident affected: A, B and C." paragraph when there
//   is one, else none.
// - impact: null. The feed does not publish one, and an update's wording is
//   not a severity.
//
// Update stamps print no year and stop at the minute. The year is the one
// that puts the stamp at or before the entry's own `updated` stamp (a day of
// slack for a clock edge), so an incident open across New Year reads right.

const INCIDENT_WORDS = ['investigating', 'identified', 'monitoring', 'resolved', 'postmortem']
// Scheduled maintenances share the feed; they are not incidents.
const MAINTENANCE_WORDS = ['scheduled', 'in progress', 'verifying', 'completed']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_MS = 86_400_000

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

interface Update {
  at: string
  word: string
}

function tag(entry: string, name: string): string | null {
  const m = entry.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? m[1]! : null
}

/** UTC instant for a "Mon D, HH:MM" stamp, in the year that keeps it at or before `anchorMs`. */
export function updateStamp(stamp: string, anchorMs: number): string {
  const m = stamp.match(/^([A-Za-z]{3}) (\d{1,2})(?:, (\d{4}))?,? (\d{2}):(\d{2}) UTC$/)
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1
  if (!m || month === -1) throw new Error(`unparseable update stamp: ${stamp}`)
  const at = (year: number) => Date.UTC(year, month, Number(m[2]), Number(m[4]), Number(m[5]))
  let ms: number
  if (m[3]) ms = at(Number(m[3]))
  else {
    const year = new Date(anchorMs).getUTCFullYear()
    ms = at(year) > anchorMs + DAY_MS ? at(year - 1) : at(year)
  }
  return new Date(ms).toISOString()
}

function parseEntry(entry: string) {
  const link = entry.match(/<link\s[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1]
  const code = link?.match(/^https:\/\/[^/]+\/incidents\/([a-z0-9]+)$/)?.[1]
  if (!link || !code) throw new Error(`entry has no /incidents/<code> link: ${link ?? 'none'}`)
  const title = decodeEntities(tag(entry, 'title') ?? '').trim()
  const updated = tag(entry, 'updated') ?? tag(entry, 'published')
  const anchorMs = updated ? Date.parse(updated) : NaN
  if (!title || Number.isNaN(anchorMs))
    throw new Error(`entry ${code} has no title or updated stamp`)

  const html = decodeEntities(tag(entry, 'content') ?? '')
  const updates: Update[] = [] // newest first, as the feed lists them
  let components: string[] = []
  for (const p of html.match(/<p>[\s\S]*?<\/p>/g) ?? []) {
    const text = textOf(p)
    const affected = text.match(/^This incident affected: (.+?)\.?$/)
    if (affected) {
      components = affected[1]!
        .split(/,\s*|\s+and\s+/)
        .map((c) => c.trim())
        .filter(Boolean)
      continue
    }
    const small = p.match(/<small>([\s\S]*?)<\/small>/)?.[1]
    const word = p.match(/<strong>([\s\S]*?)<\/strong>/)?.[1]
    if (!small || !word)
      throw new Error(`entry ${code}: unrecognized paragraph: ${text.slice(0, 80)}`)
    updates.push({ at: updateStamp(textOf(small), anchorMs), word: textOf(word).toLowerCase() })
  }
  return { code, link, title, updates, components }
}

export function parseStatuspageAtom(
  provider: 'openai' | 'anthropic' | 'mistral',
  text: string,
  prov: Provenance,
) {
  const seen = new Set<string>()
  const rows: IncidentRow[] = []
  let maintenances = 0
  for (const entry of text.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const { code, link, title, updates, components } = parseEntry(entry)
    if (seen.has(code)) continue // one row per id (stable key)
    seen.add(code)
    const words = updates.map((u) => u.word).filter((w) => w !== 'update')
    if (words.some((w) => MAINTENANCE_WORDS.includes(w))) {
      maintenances += 1
      continue
    }
    const unknown = words.find((w) => !INCIDENT_WORDS.includes(w))
    if (unknown) throw new Error(`entry ${code}: unknown status word "${unknown}"`)
    const status = words[0]
    const oldest = updates.at(-1)
    if (!status || !oldest) throw new Error(`entry ${code} states no status`)
    const resolved = updates.find((u) => u.word === 'resolved')
    rows.push({
      provider,
      incident_id: code,
      title,
      impact: null,
      status,
      started_at: oldest.at,
      resolved_at:
        resolved && (status === 'resolved' || status === 'postmortem') ? resolved.at : null,
      components: components.sort(byString),
      incident_url: link,
      ...prov,
    })
  }
  if (rows.length === 0 && maintenances === 0) throw new Error('feed has no <entry> elements')
  rows.sort((a, b) => byString(a.incident_id, b.incident_id))
  return { ...StatuspageIncidentsOutput.parse({ rows }), maintenances }
}
