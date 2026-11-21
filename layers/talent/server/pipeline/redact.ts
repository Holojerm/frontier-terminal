// Fields a job board returns that name people, removed before a payload is
// hashed, archived to R2 or parsed (layers/core/server/pipeline/lanes.ts ›
// PayloadRedaction). "Store the source bytes" means the bytes we rely on, not
// personal data a vendor happens to include: xAI's Greenhouse board puts each
// role's Team Lead (name, work email, employee id) in `metadata`, which no
// parser reads.

import type { PayloadRedaction } from '#layers/core/server/pipeline/lanes'

/** Greenhouse jobs and departments payloads: every job's `metadata` array. */
function stripGreenhouseMetadata(text: string): string {
  const data = JSON.parse(text) as {
    jobs?: Record<string, unknown>[]
    departments?: { jobs?: Record<string, unknown>[] }[]
  }
  const jobs = [...(data.jobs ?? []), ...(data.departments ?? []).flatMap((d) => d.jobs ?? [])]
  for (const job of jobs) delete job.metadata
  return JSON.stringify(data)
}

export const GREENHOUSE_REDACTION: PayloadRedaction = {
  matches: (url) => url.startsWith('https://boards-api.greenhouse.io/'),
  redact: stripGreenhouseMetadata,
}
