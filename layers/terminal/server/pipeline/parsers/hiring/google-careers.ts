import { CareersFeedJobsOutput, registerParser, type Provenance } from '../../contracts'
import { decodeEntities } from '../disclosures/html-text'
import { fixtureProvenance } from '../fixture-provenance'
import { compareByJobId } from './common'

// google-careers — the job feed Google's careers site publishes for
// aggregators (www.google.com/about/careers/applications/jobs/feed.xml): one
// <job> per posting, Alphabet-wide. Only rows whose <employer> is DeepMind
// are kept, the same board deepmind.google/careers links to (results filtered
// to company=DeepMind). A Google-wide count would mix Search, Ads and Cloud
// hiring with the lab's, so everything else is counted in the run note, never
// stored. No DOM library: the feed is flat, regular XML, read the way
// google-pricing.ts reads its page. Feed text is data.

export const GOOGLE_LAB_EMPLOYER = 'DeepMind'

const JOB = /<job>([\s\S]*?)<\/job>/g

/** The text of the first <tag> in an element, XML entities decoded once; null when absent or empty. */
function field(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  if (!m) return null
  const text = decodeEntities(m[1]!).trim()
  return text === '' ? null : text
}

function all(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]!)
}

/** "London, UK"; "Mountain View, CA, USA; New York, NY, USA" — the feed's own fields, in its order. */
function locationOf(job: string): string | null {
  const places = all(job, 'location')
    .map((loc) =>
      ['city', 'state', 'country']
        .map((t) => field(loc, t))
        .filter((part): part is string => part !== null)
        .join(', '),
    )
    .filter((place) => place !== '')
  return places.length ? places.join('; ') : null
}

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseGoogleCareers(
  text: string,
  prov: Provenance = fixtureProvenance('google-careers'),
) {
  if (!text.includes('<jobs>')) throw new Error('google-careers: no <jobs> root in the feed')
  const seen = new Set<string>()
  const rows = []
  const skipped = new Map<string, number>()
  for (const [, job] of text.matchAll(JOB)) {
    const employer = field(job!, 'employer')
    const jobId = field(job!, 'jobid')
    const title = field(job!, 'title')
    if (!employer || !jobId || !title) {
      throw new Error(`google-careers: a <job> lacks employer, jobid or title (${jobId ?? '?'})`)
    }
    if (employer !== GOOGLE_LAB_EMPLOYER) {
      skipped.set(employer, (skipped.get(employer) ?? 0) + 1)
      continue
    }
    if (seen.has(jobId)) continue // one row per id (stable key)
    seen.add(jobId)
    // Categories are Google's own enum labels (SOFTWARE_ENGINEERING), stored
    // verbatim; the few roles filed under several keep all of them, in order.
    const categories = all(job!, 'category').map((c) => decodeEntities(c).trim())
    rows.push({
      provider: 'google' as const,
      job_id: jobId,
      title,
      department: categories.length ? categories.join(', ') : null,
      team: null, // the feed has no team field
      location: locationOf(job!),
      employment_type: field(job!, 'jobtype'),
      published_at: field(job!, 'published'),
      updated_at: null, // the feed stamps the whole file, not each job
      company_name: employer,
      source_url: prov.source_url,
      fetched_at: prov.fetched_at,
    })
  }
  if (rows.length === 0) {
    throw new Error(`google-careers: no ${GOOGLE_LAB_EMPLOYER} roles in the feed`)
  }
  rows.sort(compareByJobId)
  const note = [...skipped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([employer, n]) => `${employer} ${n}`)
    .join(', ')
  return { ...CareersFeedJobsOutput.parse({ rows }), skipped: note }
}

registerParser({
  name: 'google-careers',
  lane: 'hiring',
  fixturePath: 'fixtures/hiring/google-careers.xml',
  sideFixturePaths: [],
  schema: CareersFeedJobsOutput,
  // The registry hashes the schema-shaped output; `skipped` is a run note.
  parse: (text) => ({ rows: parseGoogleCareers(text).rows }),
})
