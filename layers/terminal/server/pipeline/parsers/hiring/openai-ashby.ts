import { AshbyJobsOutput, registerParser, type Provenance } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { compareByJobId } from './common'

// OpenAI job board via Ashby's posting API. Department and team are inline
// on every job object — no join needed.

interface AshbyJob {
  id: string
  title: string
  department: string | null
  team: string | null
  location: string | null
  employmentType: string | null
  publishedAt: string | null
}

// prov defaults to the fixture manifest's record (single-arg behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseOpenaiAshby(
  fixtureText: string,
  prov: Provenance = fixtureProvenance('openai-ashby'),
) {
  const payload = JSON.parse(fixtureText) as { jobs: AshbyJob[] }
  const rows = payload.jobs
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
  // Validating inside parse makes contract conformance part of the parser's
  // own done-bar, not just the tests'.
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
