// Pure readers from a board's bytes to its open roles, one per platform.
// Each throws on a payload it does not recognise, so a changed API is a
// failed read, never a board that seems to have emptied.

import { classifyRole, type BoardPlatform, type RoleClass } from '../../shared/utils/listed-hiring'
import { all, field, locationOf } from '../pipeline/parsers/hiring/google-careers'
import { decodeEntities } from '../pipeline/parsers/disclosures/html-text'

export interface ListedRole {
  job_id: string
  title: string
  department: string | null
  location: string | null
  published_at: string | null
  role_class: RoleClass
}

/** Listed postings with no title can't be stored; more than this means the payload moved. */
export const MAX_UNTITLED = 3

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

function role(
  job_id: string,
  title: string,
  department: string | null,
  location: string | null,
  published_at: string | null,
  classDepartment = department,
): ListedRole {
  return {
    job_id,
    title,
    department,
    location,
    published_at,
    role_class: classifyRole(title, classDepartment),
  }
}

function byId(a: ListedRole, b: ListedRole): number {
  return a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0
}

function checkUntitled(board: string, untitled: number, listed: number): void {
  if (untitled > MAX_UNTITLED || (untitled > 0 && untitled === listed)) {
    throw new Error(`${board}: ${untitled} of ${listed} listed roles have no title`)
  }
}

interface GreenhouseDepartment {
  name?: unknown
  child_ids?: unknown
  jobs?: {
    id?: unknown
    title?: unknown
    location?: { name?: unknown } | null
    first_published?: unknown
  }[]
}

/**
 * Greenhouse's /departments: every department with its open jobs inline, so
 * one request gives each role its department (the /jobs endpoint carries
 * none). A job filed under a parent and a child keeps the child's name.
 */
export function parseGreenhouseDepartments(body: string): ListedRole[] {
  const payload = JSON.parse(body) as { departments?: unknown }
  if (!Array.isArray(payload.departments)) throw new Error('greenhouse: no departments array')
  const departments = payload.departments as GreenhouseDepartment[]
  const seen = new Map<string, { role: ListedRole; leaf: boolean }>()
  let untitled = 0
  let listed = 0
  for (const d of departments) {
    if (!Array.isArray(d.jobs)) throw new Error('greenhouse: a department has no jobs array')
    const name = text(d.name)
    const department = name === null || name === 'No Department' ? null : name
    const leaf = !Array.isArray(d.child_ids) || d.child_ids.length === 0
    for (const job of d.jobs) {
      if (typeof job.id !== 'number' && typeof job.id !== 'string') {
        throw new Error('greenhouse: a job has no id')
      }
      const id = String(job.id)
      const prior = seen.get(id)
      if (prior && (prior.leaf || !leaf)) continue
      if (!prior) listed++
      const title = text(job.title)
      if (title === null) {
        if (!prior) untitled++
        continue
      }
      seen.set(id, {
        role: role(id, title, department, text(job.location?.name), text(job.first_published)),
        leaf,
      })
    }
  }
  checkUntitled('greenhouse', untitled, listed)
  return [...seen.values()].map((s) => s.role).sort(byId)
}

interface AshbyJob {
  id?: unknown
  title?: unknown
  department?: unknown
  location?: unknown
  publishedAt?: unknown
  isListed?: unknown
}

/** Ashby's posting API: department inline. A posting the board hides is not open. */
export function parseAshbyBoard(body: string): ListedRole[] {
  const payload = JSON.parse(body) as { jobs?: unknown }
  if (!Array.isArray(payload.jobs)) throw new Error('ashby: no jobs array')
  const jobs = (payload.jobs as AshbyJob[]).filter((j) => j.isListed !== false)
  const roles: ListedRole[] = []
  let untitled = 0
  for (const job of jobs) {
    if (typeof job.id !== 'string') throw new Error('ashby: a job has no id')
    const title = text(job.title)
    if (title === null) {
      untitled++
      continue
    }
    roles.push(role(job.id, title, text(job.department), text(job.location), text(job.publishedAt)))
  }
  checkUntitled('ashby', untitled, jobs.length)
  return roles.sort(byId)
}

interface HibobJob {
  id?: unknown
  title?: unknown
  department?: unknown
  site?: unknown
  country?: unknown
  publishedAt?: unknown
}

/**
 * HiBob's careers API (the JSON its careers page reads). Departments carry a
 * cost-centre code ("5310 US Architecture & FW R&D"): stored verbatim, and
 * classed without the code.
 */
export function parseHibobBoard(body: string): ListedRole[] {
  const payload = JSON.parse(body) as { jobAdDetails?: unknown }
  if (!Array.isArray(payload.jobAdDetails)) throw new Error('hibob: no jobAdDetails array')
  const jobs = payload.jobAdDetails as HibobJob[]
  const roles: ListedRole[] = []
  let untitled = 0
  for (const job of jobs) {
    if (typeof job.id !== 'string') throw new Error('hibob: a job has no id')
    const title = text(job.title)
    if (title === null) {
      untitled++
      continue
    }
    const department = text(job.department)
    const place = [text(job.site), text(job.country)].filter(Boolean).join(', ')
    roles.push(
      role(
        job.id,
        title,
        department,
        place || null,
        text(job.publishedAt),
        department?.replace(/^\d+\s+/, '') ?? null,
      ),
    )
  }
  checkUntitled('hibob', untitled, jobs.length)
  return roles.sort(byId)
}

/** The employer the hyperscaler board counts: Google itself, not DeepMind or YouTube. */
export const GOOGLE_EMPLOYER = 'Google'

/**
 * Data-center roles in Google's careers feed. Categories are Google's own
 * enum labels (DATA_CENTER_OPERATIONS), read with the underscores as spaces.
 * Only roles classed datacenter are kept: the feed is read for nothing else.
 */
export function googleDatacenterRole(job: string): ListedRole | null {
  const employer = field(job, 'employer')
  const id = field(job, 'jobid')
  const title = field(job, 'title')
  if (!employer || !id || !title) {
    throw new Error(`google-feed: a <job> lacks employer, jobid or title (${id ?? '?'})`)
  }
  if (employer !== GOOGLE_EMPLOYER) return null
  const categories = all(job, 'category').map((c) => decodeEntities(c).trim())
  const department = categories.length ? categories.join(', ') : null
  const r = role(
    id,
    title,
    department,
    locationOf(job),
    field(job, 'published'),
    department?.replace(/_/g, ' ') ?? null,
  )
  return r.role_class === 'datacenter' ? r : null
}

/**
 * The feed as a stream of <job> elements, so the ~20 MB file is never held
 * whole: only the current job and the unread tail of a chunk are.
 */
export async function readGoogleFeed(stream: ReadableStream<Uint8Array>): Promise<ListedRole[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let rooted = false
  const seen = new Map<string, ListedRole>()
  const drain = () => {
    for (;;) {
      const start = buffer.indexOf('<job>')
      if (start === -1) {
        buffer = buffer.slice(Math.max(0, buffer.length - 4))
        return
      }
      const end = buffer.indexOf('</job>', start)
      if (end === -1) {
        buffer = buffer.slice(start)
        return
      }
      const r = googleDatacenterRole(buffer.slice(start, end + 6))
      if (r && !seen.has(r.job_id)) seen.set(r.job_id, r)
      buffer = buffer.slice(end + 6)
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    if (!rooted && buffer.includes('<jobs>')) rooted = true
    drain()
  }
  buffer += decoder.decode()
  if (!rooted && buffer.includes('<jobs>')) rooted = true
  drain()
  if (!rooted) throw new Error('google-feed: no <jobs> root in the feed')
  return [...seen.values()].sort(byId)
}

/** The reader for a platform's JSON body (the Google feed is streamed instead). */
export function parseBoard(platform: Exclude<BoardPlatform, 'google-feed'>, body: string) {
  switch (platform) {
    case 'greenhouse':
      return parseGreenhouseDepartments(body)
    case 'ashby':
      return parseAshbyBoard(body)
    case 'hibob':
      return parseHibobBoard(body)
  }
}
