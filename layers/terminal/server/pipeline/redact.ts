// Fields a public source returns that name people, removed before a payload
// is hashed, archived to R2 or parsed. "Store the source bytes" means the
// bytes we rely on, not personal data a vendor happens to include: xAI's
// Greenhouse board puts each role's Team Lead (name, work email, employee id)
// in `metadata`, which no parser reads.
//
// Redaction is part of the snapshot: the content hash and the archived object
// are of the redacted text, so the archive never holds the removed fields.

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

const isGreenhouse = (url: string) => url.startsWith('https://boards-api.greenhouse.io/')

/** The payload as it may be stored. Unparseable JSON is left for the parser to reject. */
export function redactPayload(url: string, text: string): string {
  if (!isGreenhouse(url)) return text
  try {
    return stripGreenhouseMetadata(text)
  } catch {
    return text
  }
}
