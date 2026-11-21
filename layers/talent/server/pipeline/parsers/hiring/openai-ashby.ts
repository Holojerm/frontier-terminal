import {
  AshbyJobsOutput,
  registerParser,
  type Provenance,
} from '#layers/core/server/utils/contracts'
import { fixtureProvenance } from '#layers/core/server/utils/fixture-provenance'
import { compareByJobId } from './common'

// OpenAI job board via Ashby's posting API. Department and team are inline on every job
// object, so no join is needed.

interface AshbyJob {
  id: string
  title: string | null
  department: string | null
  team: string | null
  location: string | null
  employmentType: string | null
  publishedAt: string | null
  isListed?: boolean
}

// A posting the board hides (isListed: false) is not an open role, the same rule
// wayback-boards.ts applies to archived boards. A listed posting with no title cannot be
// stored (titles are never invented), so it is skipped rather than stalling the board.
// More than a handful, or a board whose every posting is untitled, means the payload moved
// (a renamed field); a silent mass "removal" would be worse than a failed poll, so those
// throw.
export const MAX_UNTITLED_JOBS = 3

function hasTitle(job: AshbyJob): job is AshbyJob & { title: string } {
  return typeof job.title === 'string' && job.title.trim() !== ''
}

// prov defaults to the fixture manifest's record, so single-arg output is byte-identical
// for the determinism gate; the refresh orchestrator passes the live fetch's provenance.
export function parseOpenaiAshby(
  fixtureText: string,
  prov: Provenance = fixtureProvenance('openai-ashby'),
) {
  const payload = JSON.parse(fixtureText) as { jobs: AshbyJob[] }
  const listed = payload.jobs.filter((job) => job.isListed !== false)
  const untitled = listed.filter((job) => !hasTitle(job)).map((job) => job.id)
  if (
    untitled.length > MAX_UNTITLED_JOBS ||
    (untitled.length > 0 && untitled.length === listed.length)
  ) {
    throw new Error(`ashby: ${untitled.length} listed job(s) have no title: ${untitled.join(', ')}`)
  }
  if (untitled.length > 0) {
    console.warn(
      `ashby: skipped ${untitled.length} listed job(s) with no title: ${untitled.join(', ')}`,
    )
  }
  const rows = listed
    .filter(hasTitle)
    .map((job) => ({
      provider: 'openai' as const,
      job_id: job.id,
      title: job.title,
      department: job.department ?? null,
      team: job.team ?? null,
      location: job.location ?? null,
      employment_type: job.employmentType ?? null,
      published_at: job.publishedAt ?? null,
      updated_at: null, // Ashby posting API exposes no update timestamp
      company_name: null, // no company field in the Ashby payload; never invented
      source_url: prov.source_url,
      fetched_at: prov.fetched_at,
    }))
    .sort(compareByJobId)
  // Validated inside parse, so a contract break fails the parser and not only the tests.
  return AshbyJobsOutput.parse({ rows })
}

registerParser({
  name: 'openai-ashby',
  lane: 'hiring',
  fixturePath: 'fixtures/hiring/openai-ashby.json',
  sideFixturePaths: [],
  schema: AshbyJobsOutput,
  parse: (text) => parseOpenaiAshby(text),
})
