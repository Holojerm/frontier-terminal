import { GreenhouseJobsOutput, type Provenance } from '../../contracts'

// Shared helpers for the hiring lane. Deterministic: no clocks, no
// randomness, no locale-sensitive compares.

// Plain code-unit compare — localeCompare is environment-sensitive and
// would break the determinism gate's cross-machine promise.
export function compareByJobId(a: { job_id: string }, b: { job_id: string }): number {
  return a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0
}

// ---- Greenhouse (shared by anthropic + xai boards) -------------------------

export interface GreenhouseJob {
  id: number
  title: string
  location: { name: string } | null
  first_published: string | null
  updated_at: string | null
  company_name: string | null
}

interface GreenhouseDepartment {
  name: string
  jobs: { id: number }[]
}

export function greenhouseRow(
  job: GreenhouseJob,
  provider: 'anthropic' | 'xai',
  department: string | null,
  prov: Provenance,
) {
  return {
    provider,
    job_id: String(job.id),
    title: job.title,
    department,
    team: null, // Greenhouse board API has no team concept
    location: job.location?.name ?? null,
    employment_type: null, // not carried by the Greenhouse jobs endpoint
    published_at: job.first_published ?? null,
    updated_at: job.updated_at ?? null,
    // Passed through verbatim: for the xai board this is "SpaceXAI"
    // (entity-blended SpaceX/xAI artifact) and must never be rewritten.
    company_name: job.company_name ?? null,
    source_url: prov.source_url,
    fetched_at: prov.fetched_at,
  }
}

// A Greenhouse jobs payload carries NO department field; department comes
// only from the /departments join, which is why every Greenhouse parser
// takes two payloads. Live boards are joined against their own live
// /departments, never against the committed fixture.
export function parseGreenhouseBoard(
  provider: 'anthropic' | 'xai',
  jobsText: string,
  departmentsText: string,
  prov: Provenance,
) {
  const payload = JSON.parse(jobsText) as { jobs: GreenhouseJob[] }
  const departmentsPayload = JSON.parse(departmentsText) as {
    departments: GreenhouseDepartment[]
  }

  const deptByJobId = new Map<number, string>()
  for (const dept of departmentsPayload.departments) {
    for (const job of dept.jobs) {
      // First mapping wins (file order — deterministic). The committed
      // fixtures are join-consistent: no job id appears under two departments.
      if (!deptByJobId.has(job.id)) deptByJobId.set(job.id, dept.name)
    }
  }

  const rows = payload.jobs
    .map((job) => {
      const department = deptByJobId.get(job.id)
      if (department === undefined) {
        // Fail loudly rather than emit a null department: the join is this
        // source's whole reason for a second fetch, and silent nulls would
        // hide source drift from the repair path.
        throw new Error(`${provider}-greenhouse: job ${job.id} missing from departments join`)
      }
      return greenhouseRow(job, provider, department, prov)
    })
    .sort(compareByJobId)
  return GreenhouseJobsOutput.parse({ rows })
}
