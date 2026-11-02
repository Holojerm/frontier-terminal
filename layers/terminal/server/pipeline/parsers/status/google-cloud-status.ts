import {
  GoogleCloudIncidentsOutput,
  registerParser,
  type IncidentRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'

// google-cloud-status — status.cloud.google.com/incidents.json, Google
// Cloud's own format (not Statuspage). The feed is Alphabet-cloud-wide, so
// only incidents touching a Gemini / Vertex AI product are kept: an
// unfiltered count would conflate Compute and BigQuery outages with Gemini
// and mislead — the same reasoning that cuts Google hiring (sources.yaml).
// Everything else is counted, not silently dropped. Feed text is data.

interface GoogleCloudIncident {
  id: string
  begin: string
  end?: string | null
  external_desc: string
  severity: string
  status_impact: string
  affected_products?: { title: string }[]
  most_recent_update?: { status: string } | null
  uri: string
}

const GOOGLE_STATUS_ORIGIN = 'https://status.cloud.google.com/'

/** The exact product filter, stated once. sources.yaml quotes this rule. */
export function isGeminiProduct(title: string): boolean {
  return /gemini/i.test(title) || title === 'Vertex AI'
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseGoogleCloudStatus(
  text: string,
  prov: Provenance = fixtureProvenance('google-cloud-status'),
) {
  const feed = JSON.parse(text) as GoogleCloudIncident[]
  const seen = new Set<string>()
  const rows: IncidentRow[] = []
  let skipped = 0
  for (const incident of feed) {
    if (seen.has(incident.id)) continue
    seen.add(incident.id)
    const products = (incident.affected_products ?? []).map((p) => p.title)
    if (!products.some(isGeminiProduct)) {
      skipped += 1
      continue
    }
    rows.push({
      provider: 'google',
      incident_id: incident.id,
      title: incident.external_desc,
      impact: incident.severity,
      // Google has no lifecycle field of its own; the newest update's status
      // (AVAILABLE once over) is the closest thing, else the impact class.
      status: incident.most_recent_update?.status ?? incident.status_impact,
      started_at: incident.begin,
      resolved_at: incident.end ?? null,
      components: [...products].sort(byString),
      incident_url: `${GOOGLE_STATUS_ORIGIN}${incident.uri.replace(/^\/+/, '')}`,
      ...prov,
    })
  }
  rows.sort((a, b) => byString(a.incident_id, b.incident_id))
  return { ...GoogleCloudIncidentsOutput.parse({ rows }), skipped }
}

registerParser({
  name: 'google-cloud-status',
  lane: 'status',
  fixturePath: 'fixtures/status/google-cloud-status.json',
  sideFixturePaths: [],
  schema: GoogleCloudIncidentsOutput,
  // The registry hashes the schema-shaped output; `skipped` is a run note.
  parse: (text) => ({ rows: parseGoogleCloudStatus(text).rows }),
})
