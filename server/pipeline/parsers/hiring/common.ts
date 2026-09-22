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

/**
 * A join mismatch small enough to be the snapshot race rather than drift.
 *
 * The board is two HTTP requests about a second apart, so a job posted
 * between them is in /jobs and not yet in /departments. Anthropic's board
 * failed this way on 2026-09-18 over a single job id.
 *
 * The throw itself is right and stays: dropping the job, or emitting it with
 * a null department, both move a cluster count by one for a tick, and a
 * cluster count that dips and recovers is exactly the shape of the hiring
 * signal this terminal alerts on. Losing one tick is cheaper than a headline
 * saying a lab pulled a role it did not pull. What the type changes is who
 * hears about it: server/pipeline/refresh.ts raises the ops event for this
 * class only when the next tick has not cleared it.
 */
export class JoinRaceError extends Error {}

/**
 * Unjoined jobs that can still be the race rather than a changed payload.
 *
 * Above this the two feeds disagree about more than a second's worth of
 * postings, which is drift — and if Greenhouse stops listing ids under
 * departments at all, every job is unjoined at once and lands well clear of
 * it. Five is loose enough for a busy second and tight enough to still be a
 * tripwire.
 */
export const MAX_UNJOINED_JOBS = 5

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

  // Fail loudly rather than emit a null department: the join is this source's
  // whole reason for a second fetch, and silent nulls would hide source drift
  // from the repair path. Every unjoined id is named, not just the first, so
  // the run detail says whether this was one posting or a broken payload.
  const unjoined = payload.jobs.filter((job) => !deptByJobId.has(job.id)).map((job) => job.id)
  if (unjoined.length > 0) {
    const message = `${provider}-greenhouse: ${unjoined.length} job(s) missing from departments join: ${unjoined.join(', ')}`
    throw unjoined.length <= MAX_UNJOINED_JOBS ? new JoinRaceError(message) : new Error(message)
  }

  const rows = payload.jobs
    .map((job) => greenhouseRow(job, provider, deptByJobId.get(job.id)!, prov))
    .sort(compareByJobId)
  return GreenhouseJobsOutput.parse({ rows })
}
