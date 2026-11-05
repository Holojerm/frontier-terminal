import { NO_DEPARTMENT } from '../../../utils/terminal-history'
import { decodeEntities, textOf } from '../disclosures/html-text'

// The labs' job boards as the Internet Archive captured them
// (archive/hiring-eras.ts names each era's URL and window). Each parser
// reads one capture into the counts the live hiring lane derives from a
// board: open roles in total and per department, by the board's own
// department labels. Nothing per role is kept, only the counts.
//
// A capture counts only when it lists every open role, or states the
// board's own total. A list cut short by paging, a "show more" button or a
// script the Archive did not run is not a count, so:
//
//   boards.greenhouse.io/<board> (to early 2025): every opening, grouped by
//     department, in one page. Counted per department.
//   boards-api.greenhouse.io/v1/boards/<board>/departments: every job under
//     its department, the live join. Counted per department.
//   boards-api.greenhouse.io/v1/boards/<board>/jobs: every job, with no
//     department. Total only.
//   job-boards.greenhouse.io/<board> (from 2025): 50 roles a page, with the
//     board's own `total`. Per department only when one page holds them all;
//     otherwise the stated total alone.
//   jobs.ashbyhq.com/<org>: every listed posting with its department, in the
//     page's app data. Counted per department.
//   jobs.lever.co/<org>: every posting, grouped by the board's top-level
//     category. Counted per category.
//
// A throw is a skip with the message as its reason (archive/rows.ts). A
// board listing no role at all is a skip too: on these pages it means the
// board moved or the capture holds a shell, never that the lab hired nobody.

export interface ArchivedDepartmentCount {
  /** The department as the board printed it, entities decoded and trimmed. */
  label: string
  /** The board's own id for the department, where the capture prints one. */
  department_id: string | null
  open_roles: number
}

export interface ArchivedBoardCount {
  total: number
  /** Every department with its count, summing to total; null when the capture states only the total. */
  departments: ArchivedDepartmentCount[] | null
  /** What the capture showed beyond the counts, for archive_captures.detail. */
  note?: string
}

const byLabel = (a: ArchivedDepartmentCount, b: ArchivedDepartmentCount) =>
  a.label < b.label ? -1 : a.label > b.label ? 1 : 0

function tally(
  roles: readonly { id: string; label: string; department_id: string | null }[],
  what: string,
): ArchivedBoardCount {
  if (roles.length === 0) throw new Error(`${what}: no open role listed`)
  const seen = new Set<string>()
  const counts = new Map<string, ArchivedDepartmentCount>()
  for (const r of roles) {
    // One count per role: a role listed twice on a page is still one opening.
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const key = `${r.department_id ?? ''}\n${r.label}`
    const held = counts.get(key)
    if (held) held.open_roles++
    else counts.set(key, { label: r.label, department_id: r.department_id, open_roles: 1 })
  }
  const departments = [...counts.values()].sort(byLabel)
  return { total: seen.size, departments }
}

const label = (raw: string) => decodeEntities(raw).replace(/\s+/g, ' ').trim()

// ---- Greenhouse, the old embedded board ------------------------------------

/**
 * boards.greenhouse.io/<board>: a heading per department (`<h3 id="…">`,
 * `<h4>` for a sub-department) and a `<div class="opening">` per role whose
 * department_id names its department and, nested, the parent's too. A role
 * counts under the deepest department it names, the one the live
 * /departments join lists it under.
 */
export function parseGreenhouseBoardHtml(text: string): ArchivedBoardCount {
  if (!/id="board_title"/.test(text) && !/Current Job Openings/i.test(text)) {
    throw new Error('greenhouse board: no "Current Job Openings" board on the page')
  }
  const headings = new Map<string, { name: string; depth: number }>()
  for (const m of text.matchAll(/<h([2-6])\s+id="(\d+)"[^>]*>([\s\S]*?)<\/h\1>/g)) {
    headings.set(m[2]!, { name: label(textOf(m[3]!)), depth: Number(m[1]) })
  }
  const roles: { id: string; label: string; department_id: string | null }[] = []
  for (const m of text.matchAll(
    /<div\s+class="opening"([^>]*)>\s*<a[^>]*href="[^"]*\/jobs\/(\d+)[^"]*"/g,
  )) {
    const ids = (m[1]!.match(/department_id="([^"]*)"/)?.[1] ?? '').split(',').filter(Boolean)
    if (ids.length === 0) throw new Error(`greenhouse board: opening ${m[2]} names no department`)
    const named = ids.map((id) => ({ id, h: headings.get(id) }))
    const missing = named.filter((n) => !n.h).map((n) => n.id)
    if (missing.length) {
      throw new Error(`greenhouse board: department ${missing.join(', ')} has no heading`)
    }
    const deepest = named.reduce((a, b) => (b.h!.depth >= a.h!.depth ? b : a))
    roles.push({ id: m[2]!, label: deepest.h!.name, department_id: deepest.id })
  }
  const openings = (text.match(/<div\s+class="opening"/g) ?? []).length
  if (openings !== roles.length) {
    throw new Error(`greenhouse board: ${openings} openings, ${roles.length} with a job link`)
  }
  return tally(roles, 'greenhouse board')
}

// ---- Greenhouse, the board API ---------------------------------------------

interface GreenhouseDepartment {
  id: number
  name: string
  jobs: { id: number }[]
}

/** boards-api …/departments: each job under the first department that lists it, as the live join does. */
export function parseGreenhouseDepartmentsJson(text: string): ArchivedBoardCount {
  const payload = JSON.parse(text) as { departments?: GreenhouseDepartment[] }
  if (!Array.isArray(payload.departments)) throw new Error('greenhouse departments: no departments')
  const roles = payload.departments.flatMap((d) =>
    (d.jobs ?? []).map((j) => ({
      id: String(j.id),
      label: label(d.name),
      department_id: String(d.id),
    })),
  )
  return tally(roles, 'greenhouse departments')
}

/** boards-api …/jobs: every job, no department field. */
export function parseGreenhouseJobsJson(text: string): ArchivedBoardCount {
  const payload = JSON.parse(text) as { jobs?: { id: number }[]; meta?: { total?: number } }
  if (!Array.isArray(payload.jobs)) throw new Error('greenhouse jobs: no jobs array')
  const ids = new Set(payload.jobs.map((j) => String(j.id)))
  if (ids.size === 0) throw new Error('greenhouse jobs: no open role listed')
  if (typeof payload.meta?.total === 'number' && payload.meta.total !== payload.jobs.length) {
    throw new Error(
      `greenhouse jobs: meta.total ${payload.meta.total} but ${payload.jobs.length} jobs`,
    )
  }
  return { total: ids.size, departments: null }
}

// ---- Greenhouse, the job-boards app (2025 on) -------------------------------

interface RemixJobPosts {
  count: number
  page: number
  total: number
  total_pages: number
  data: { id: number; department?: { id: number; name: string } | null }[]
}

/** The JSON a `window.<name> = {…};` script assigns. */
function assignedJson(text: string, name: string): unknown {
  const start = text.indexOf(`window.${name} = `)
  if (start === -1) throw new Error(`no window.${name} on the page`)
  const from = start + `window.${name} = `.length
  const end = text.indexOf(';</script>', from)
  const line = text.indexOf('\n', from)
  const stop = end === -1 ? line : line === -1 ? end : Math.min(end, line)
  if (stop === -1) throw new Error(`window.${name} never ends`)
  return JSON.parse(text.slice(from, stop).trim().replace(/;$/, ''))
}

/**
 * job-boards.greenhouse.io/<board>: the server-rendered first page of the
 * board app. Its loader data states the board's `total` (the same number the
 * /departments join sums to: 174 on both, Anthropic, 2025-09-02 and -03), so
 * that total is the board-wide count. The page carries 50 roles; only when
 * one page holds every role is the department split complete.
 */
export function parseGreenhouseJobBoardsHtml(text: string): ArchivedBoardCount {
  const context = assignedJson(text, '__remixContext') as {
    state?: { loaderData?: Record<string, { jobPosts?: RemixJobPosts } | null> }
  }
  const routes = Object.values(context.state?.loaderData ?? {})
  const posts = routes.find((r) => r?.jobPosts)?.jobPosts
  if (!posts) throw new Error('job-boards: no jobPosts in the loader data')
  if (!Number.isInteger(posts.total) || posts.total <= 0) {
    throw new Error(`job-boards: board total ${posts.total}`)
  }
  if (posts.page !== 1) throw new Error(`job-boards: capture is page ${posts.page}`)
  if (posts.total_pages > 1 || posts.data.length < posts.total) {
    return {
      total: posts.total,
      departments: null,
      note: `page 1 of ${posts.total_pages} lists ${posts.data.length} of ${posts.total} roles: total only`,
    }
  }
  if (posts.data.length !== posts.total) {
    throw new Error(`job-boards: lists ${posts.data.length} roles but states ${posts.total}`)
  }
  const roles = posts.data.map((p) =>
    p.department
      ? {
          id: String(p.id),
          label: label(p.department.name),
          department_id: String(p.department.id),
        }
      : { id: String(p.id), label: NO_DEPARTMENT, department_id: null },
  )
  return tally(roles, 'job-boards')
}

// ---- Ashby ------------------------------------------------------------------

interface AshbyPosting {
  id: string
  departmentId?: string | null
  departmentName?: string | null
  isListed?: boolean
  teamId?: string | null
}

interface AshbyTeam {
  id: string
  name: string
  parentTeamId: string | null
}

/**
 * jobs.ashbyhq.com/<org>: the page's `window.__appData` carries every
 * posting the board lists. Until mid-2026 each posting names its department
 * (departmentId, departmentName); later ones name only their team, and the
 * department is the top of that team's tree in `jobBoard.teams`. The two
 * agree: on OpenAI's 2025-07-24 capture all 318 postings' departmentId is the
 * root of their teamId. Unlisted postings are left out, as the posting API
 * leaves them out.
 */
export function parseAshbyBoardHtml(text: string): ArchivedBoardCount {
  const data = assignedJson(text, '__appData') as {
    jobBoard?: { jobPostings?: AshbyPosting[]; teams?: AshbyTeam[] } | null
  }
  const postings = data.jobBoard?.jobPostings
  if (!Array.isArray(postings)) throw new Error('ashby: no jobBoard.jobPostings in the app data')
  const teams = new Map((data.jobBoard?.teams ?? []).map((t) => [t.id, t]))
  const rootOf = (id: string): AshbyTeam => {
    let team = teams.get(id)
    for (let hops = 0; team?.parentTeamId; hops++) {
      if (hops > 20) throw new Error(`ashby: team ${id} has a cycle in its parents`)
      team = teams.get(team.parentTeamId)
    }
    if (!team) throw new Error(`ashby: team ${id} is not in the board's team tree`)
    return team
  }
  const listed = postings.filter((p) => p.isListed !== false)
  // A posting with no department or team is counted as the live lane counts it.
  const roles = listed.map((p) => {
    if (p.departmentName) {
      return { id: p.id, label: label(p.departmentName), department_id: p.departmentId ?? null }
    }
    if (p.teamId) {
      const root = rootOf(p.teamId)
      return { id: p.id, label: label(root.name), department_id: root.id }
    }
    return { id: p.id, label: NO_DEPARTMENT, department_id: null }
  })
  const out = tally(roles, 'ashby')
  const unlisted = postings.length - listed.length
  return unlisted ? { ...out, note: `${unlisted} unlisted posting(s) not counted` } : out
}

// ---- Lever ------------------------------------------------------------------

/**
 * jobs.lever.co/<org>: a `postings-group` per top-level category, headed by
 * its `large-category-label`, then a `posting` per role. A sub-category
 * (`medium-category-label`) groups within it and is not a department of
 * its own: the role counts under the top-level label.
 */
export function parseLeverBoardHtml(text: string): ArchivedBoardCount {
  if (!/class="postings-group"/.test(text)) {
    throw new Error('lever: no postings on the page')
  }
  const roles: { id: string; label: string; department_id: string | null }[] = []
  const marks = [
    ...text.matchAll(
      /<div class="posting-category-title large-category-label">([\s\S]*?)<\/div>|<div class="posting" data-qa-posting-id="([^"]+)"/g,
    ),
  ]
  let current: string | null = null
  for (const m of marks) {
    if (m[1] !== undefined) {
      current = label(textOf(m[1]))
      continue
    }
    if (current === null) throw new Error(`lever: posting ${m[2]} before any category`)
    roles.push({ id: m[2]!, label: current, department_id: null })
  }
  const postings = (text.match(/<div class="posting"[\s>]/g) ?? []).length
  if (postings !== roles.length) {
    throw new Error(`lever: ${postings} postings, ${roles.length} with an id`)
  }
  return tally(roles, 'lever')
}
