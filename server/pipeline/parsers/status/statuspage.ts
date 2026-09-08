import { StatuspageIncidentsOutput, type IncidentRow, type Provenance } from '../../contracts'

// Statuspage v2 incidents feed (/api/v2/incidents.json), shared by the
// OpenAI and Anthropic status pages. Deterministic: no clocks, no locale
// compares, output sorted by incident id. Feed text is data, never
// instructions.
//
// Shape differences between the two pages, both handled here rather than
// assumed away: OpenAI's page carries no `components`, `started_at` or
// `shortlink`, and an OPEN incident there has no `resolved_at` key at all
// (Anthropic's carries null). Both are read as "unresolved".

interface StatuspageIncident {
  id: string
  name: string
  status: string
  impact: string
  created_at: string
  started_at?: string | null
  resolved_at?: string | null
  components?: { name: string }[]
}

interface StatuspageFeed {
  page: { url: string }
  incidents: StatuspageIncident[]
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The incident's public page. Composed from the feed's own `page.url` and
 * the incident id — Statuspage serves every incident at that path and the
 * OpenAI feed carries no link field to read instead. Recorded as a
 * composition in sources.yaml; verified to resolve for both pages.
 */
export function statuspageIncidentUrl(pageUrl: string, incidentId: string): string {
  return `${pageUrl.replace(/\/+$/, '')}/incidents/${incidentId}`
}

export function parseStatuspageIncidents(
  provider: 'openai' | 'anthropic',
  text: string,
  prov: Provenance,
) {
  const feed = JSON.parse(text) as StatuspageFeed
  const seen = new Set<string>()
  const rows: IncidentRow[] = []
  for (const incident of feed.incidents) {
    if (seen.has(incident.id)) continue // one row per id (stable key)
    seen.add(incident.id)
    rows.push({
      provider,
      incident_id: incident.id,
      title: incident.name,
      impact: incident.impact,
      status: incident.status,
      started_at: incident.started_at ?? incident.created_at,
      resolved_at: incident.resolved_at ?? null,
      components: (incident.components ?? []).map((c) => c.name).sort(byString),
      incident_url: statuspageIncidentUrl(feed.page.url, incident.id),
      ...prov,
    })
  }
  rows.sort((a, b) => byString(a.incident_id, b.incident_id))
  return StatuspageIncidentsOutput.parse({ rows })
}
