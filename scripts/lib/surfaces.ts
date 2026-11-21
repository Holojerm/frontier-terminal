// The source-reading half of `bun run surfaces:check` (scripts/check-surfaces.ts).
// Strings in, answers out, so test/surfaces.test.ts can drive every rule without
// a filesystem. The gate keeps the walk, the waiver file and the report.
//
// Every surface is read from the code that provides it, never from a list: a
// route's MCP tool is a `serve('<name>'` whose name is the route's
// `serveTerminal(event, '<name>'`, a page's read is a `useFetch('/api/…'` (or
// `$fetch`) in its script or in a component it renders, an export is a builder
// call in the export registry, and an alert axis is the AXIS_PATH page a route
// sits under (or an AXIS_ROUTES entry naming it). The waiver file is the only
// hand-kept part: what is missing, and why.

import { endOfString, findClosing, sliceBalanced } from './brace-match'
import { blankComments } from './mcp-tools'

/** Every place a dataset can reach, as the waiver file keys them. */
export const SURFACE_KINDS = ['page', 'labPage', 'tearSheet', 'mcp', 'alerts', 'export'] as const
export type SurfaceKind = (typeof SURFACE_KINDS)[number]

/** What each kind means, for the report. */
export const SURFACE_LABEL: Record<SurfaceKind, string> = {
  page: 'no page or component fetches it',
  labPage: 'per-lab, but the lab page (labs/[lab]/index.vue) does not read it',
  tearSheet: 'per-lab, but the tear sheet (labs/[lab]/tear-sheet.vue) does not read it',
  mcp: 'no MCP tool serves its cache name',
  alerts: 'no alert axis reads it (AXIS_PATH, AXIS_ROUTES)',
  export: 'no table in EXPORT_TABLES reads it',
}

/** `kind` → subject (a route's URL, or a table's SQL name) → the one-line reason. */
export type Waivers = Partial<Record<SurfaceKind, Readonly<Record<string, string>>>>

// ── Routes ───────────────────────────────────────────────────────────────────

/** Route folders that write or serve the subscribe flow: not datasets. */
export const WRITER_DIRS = ['judge', 'gdelt', 'relay', 'subscribe'] as const

/**
 * prices/[key].get.ts (relative to the layer's server/api/) gives
 * `/api/prices/[key]`; `index.get.ts` drops its name. Null for anything that is
 * not a GET route.
 */
export function routeUrl(relFromApi: string): string | null {
  const path = relFromApi.replaceAll('\\', '/')
  const match = /^(.*)\.get\.(?:ts|js|mts|mjs)$/.exec(path)
  if (!match) return null
  const stem = match[1]!.replace(/(^|\/)index$/, '')
  return stem ? `/api/${stem}` : '/api'
}

/** True for a route under a writer folder (judge/, gdelt/, relay/, subscribe/). */
export function isWriterRoute(relFromApi: string): boolean {
  const first = relFromApi.replaceAll('\\', '/').split('/')[0]
  return (WRITER_DIRS as readonly string[]).includes(first ?? '')
}

/** The cache name a route serves under: `serveTerminal(event, '<name>'`. */
export function routeCacheName(source: string): string | null {
  return /\bserveTerminal\(\s*event\s*,\s*['"]([^'"]+)['"]/.exec(blankComments(source))?.[1] ?? null
}

/**
 * A route that takes `?lab=` is per-lab by declaration: `lab: z.…` in its query
 * schema, or `lab` destructured from a validated query (a shared schema such as
 * labQuerySchema).
 */
export function routeTakesLab(source: string): boolean {
  const code = blankComments(source)
  return (
    /(^|[\s{,])lab\s*:\s*z\./m.test(code) ||
    /\{[^}]*\blab\b[^}]*\}\s*=\s*(?:await\s+)?getValidatedQuery\(/.test(code)
  )
}

// ── MCP ──────────────────────────────────────────────────────────────────────

/**
 * Every cache name an MCP file serves: `serve('<name>'`, `serveAt('<name>'`, or
 * the tools' own `read('<name>'` (serve now, or as of a time). Prefixes such as
 * `deps.` do not matter.
 */
export function mcpServedNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const m of blankComments(source).matchAll(
    /\b(?:serve|serveAt|read)\(\s*['"]([a-z0-9][a-z0-9-]*)['"]/g,
  )) {
    names.add(m[1]!)
  }
  return names
}

// ── Pages and components ─────────────────────────────────────────────────────

/** A .vue file's `<script>` blocks; the whole file for anything else. */
export function scriptOf(source: string, isVue: boolean): string {
  if (!isVue) return source
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
}

/**
 * The `/api/…` paths a script fetches: a quoted path that opens a call's
 * argument list, as in `useFetch<T>('/api/prices'` or `$fetch(\`/api/alerts/${id}\``.
 * A link (`to="/api/…"`) is not a fetch. Interpolations become `${}` and the
 * query string is dropped.
 */
export function apiFetchPaths(script: string): string[] {
  const code = blankComments(script)
  const paths: string[] = []
  for (const m of code.matchAll(/\(\s*(['"`])\/api\//g)) {
    const start = m.index + m[0].length - '/api/'.length - 1
    const end = endOfString(code, start)
    if (end === -1) continue
    const body = code.slice(start + 1, end)
    paths.push(normalizeFetch(body))
  }
  return paths
}

function normalizeFetch(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '$' && body[i + 1] === '{') {
      const close = findClosing(body, i + 1)
      out += '${}'
      i = close === -1 ? body.length : close
      continue
    }
    out += body[i]
  }
  return out.split('?')[0]!.replace(/\/+$/, '')
}

/**
 * The route a fetched path lands on. A literal segment must match exactly; a
 * route's `[param]` takes any one segment. An exact route wins over a dynamic one.
 */
export function matchRoute(fetchPath: string, routeUrls: readonly string[]): string | null {
  const parts = fetchPath.split('/')
  let best: { url: string; dynamic: number } | null = null
  for (const url of routeUrls) {
    const segs = url.split('/')
    if (segs.length !== parts.length) continue
    let dynamic = 0
    const ok = segs.every((seg, i) => {
      if (/^\[.+\]$/.test(seg)) {
        dynamic += 1
        return parts[i] !== ''
      }
      return seg === parts[i]
    })
    if (ok && (!best || dynamic < best.dynamic)) best = { url, dynamic }
  }
  return best?.url ?? null
}

const pascal = (s: string) =>
  s
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('')

/**
 * Nuxt's name for a component file (relative to a components/ dir):
 * Terminal/Reliability.vue is `TerminalReliability`, and a file that already
 * repeats its folder (Terminal/TerminalGap.vue) is not doubled.
 */
export function componentNameOf(relFromComponents: string): string {
  const segs = relFromComponents
    .replaceAll('\\', '/')
    .replace(/\.vue$/, '')
    .split('/')
    .map(pascal)
  if (segs.at(-1) === 'Index' && segs.length > 1) segs.pop()
  let name = ''
  for (const seg of segs) name = seg.startsWith(name) ? seg : name + seg
  return name
}

/**
 * The components a file renders: PascalCase or kebab-case tags (a `Lazy`
 * prefix dropped), and any `…/components/X.vue` it imports, for the
 * defineAsyncComponent shape.
 */
export function componentRefs(source: string): Set<string> {
  const refs = new Set<string>()
  for (const m of source.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) refs.add(m[1]!.replace(/^Lazy/, ''))
  for (const m of source.matchAll(/<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g)) {
    refs.add(pascal(m[1]!).replace(/^Lazy/, ''))
  }
  for (const m of source.matchAll(/['"`][^'"`]*\/components\/([^'"`]+\.vue)['"`]/g)) {
    refs.add(componentNameOf(m[1]!))
  }
  return refs
}

/**
 * Each file's route reads, its own plus every component it renders, followed
 * through components that render components. `files` maps a file to its
 * direct reads and the components it names; `components` maps a component name
 * to its file.
 */
export function transitiveReads(
  files: ReadonlyMap<string, { reads: readonly string[]; renders: ReadonlySet<string> }>,
  components: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const memo = new Map<string, Set<string>>()
  const visit = (file: string, stack: Set<string>): Set<string> => {
    const done = memo.get(file)
    if (done) return done
    const own = files.get(file)
    const reads = new Set(own?.reads ?? [])
    if (own) {
      stack.add(file)
      for (const name of own.renders) {
        const child = components.get(name)
        if (!child || stack.has(child)) continue
        for (const r of visit(child, stack)) reads.add(r)
      }
      stack.delete(file)
    }
    memo.set(file, reads)
    return reads
  }
  for (const file of files.keys()) visit(file, new Set())
  return memo
}

// ── Tables and exports ───────────────────────────────────────────────────────

/** `export const fooBar = sqliteTable('foo_bar'` → { camel: 'fooBar', sql: 'foo_bar' }. */
export function tableDecls(source: string): { camel: string; sql: string }[] {
  return [
    ...blankComments(source).matchAll(
      /export\s+const\s+(\w+)\s*=\s*sqliteTable\(\s*['"]([A-Za-z0-9_]+)['"]/g,
    ),
  ].map((m) => ({ camel: m[1]!, sql: m[2]! }))
}

/**
 * The export builders in terminal-export-views.ts (each `export function X(…):
 * ExportTable`), with the tables each one's own body reads (`.from(tables.Y)`).
 * A builder handed a table as an argument (plainTable) exports that one instead;
 * see exportEntries.
 */
export function exportBuilders(viewsSource: string): Map<string, string[]> {
  const code = blankComments(viewsSource)
  const starts = [...code.matchAll(/export\s+function\s+(\w+)/g)]
  const builders = new Map<string, string[]>()
  starts.forEach((m, i) => {
    const body = code.slice(m.index, starts[i + 1]?.index ?? code.length)
    if (!/\)\s*:\s*ExportTable\s*\{/.test(body)) return
    const reads = [...body.matchAll(/\.from\(\s*tables\.(\w+)\s*\)/g)].map((r) => r[1]!)
    builders.set(m[1]!, [...new Set(reads)])
  })
  return builders
}

/** A call's top-level arguments, trimmed. `text` starts at the call's `(`. */
export function topLevelArgs(text: string): string[] {
  const inner = text.slice(1, -1)
  const args: string[] = []
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = endOfString(inner, i)
      if (end === -1) return []
      i = end
    } else if (ch === '(' || ch === '[' || ch === '{') {
      const end = findClosing(inner, i)
      if (end === -1) return []
      i = end
    } else if (ch === ',') {
      args.push(inner.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = inner.slice(start).trim()
  if (last) args.push(last)
  return args
}

export interface ExportEntry {
  /** The export's own name, its first argument. */
  name: string
  builder: string
  /** The D1 tables it reads, as schema identifiers (camelCase). */
  reads: string[]
}

/**
 * Every builder call in an export registry file. A bare `tables.X` argument is
 * the table it pages; a builder with none reads what its body reads.
 */
export function exportEntries(
  source: string,
  builders: ReadonlyMap<string, string[]>,
): ExportEntry[] {
  const code = blankComments(source)
  const names = [...builders.keys()]
  if (names.length === 0) return []
  const entries: ExportEntry[] = []
  for (const m of code.matchAll(new RegExp(`\\b(${names.join('|')})\\(`, 'g'))) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue
    const open = m.index + m[0].length - 1
    const call = sliceBalanced(code, open)
    if (!call) continue
    const args = topLevelArgs(call)
    const name = /^['"]([A-Za-z0-9_]+)['"]$/.exec(args[0] ?? '')?.[1]
    if (!name) continue
    const bare = args.map((a) => /^tables\.(\w+)$/.exec(a)?.[1]).filter((t): t is string => !!t)
    entries.push({
      name,
      builder: m[1]!,
      reads: bare.length ? bare : (builders.get(m[1]!) ?? []),
    })
  }
  return entries
}

// ── Alert axes ───────────────────────────────────────────────────────────────

/** AXIS_PATH in terminal-labs.ts: where each alert axis reads in full. */
export function axisPaths(labsSource: string): Record<string, string> {
  const code = blankComments(labsSource)
  const decl = /export\s+const\s+AXIS_PATH\b[^=]*=\s*\{/.exec(code)
  if (!decl) return {}
  const body = sliceBalanced(code, decl.index + decl[0].length - 1) ?? ''
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(\w+)\s*:\s*['"](\/[^'"]*)['"]/g)) out[m[1]!] = m[2]!
  return out
}

/** AXIS_ROUTES in terminal-labs.ts: the routes an axis alerts on outside its page. */
export function axisRoutes(labsSource: string): Record<string, string[]> {
  const code = blankComments(labsSource)
  const decl = /export\s+const\s+AXIS_ROUTES\b[^=]*=\s*\{/.exec(code)
  if (!decl) return {}
  const body = sliceBalanced(code, decl.index + decl[0].length - 1) ?? ''
  const out: Record<string, string[]> = {}
  for (const m of body.matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) {
    out[m[1]!] = [...m[2]!.matchAll(/['"](\/api\/[^'"]*)['"]/g)].map((r) => r[1]!)
  }
  return out
}

/**
 * The axes whose page a route sits under (`/api/hiring/history` is under
 * `/hiring`), and those whose AXIS_ROUTES entry names it.
 */
export function axesOfRoute(
  url: string,
  paths: Readonly<Record<string, string>>,
  routes: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const page = url.replace(/^\/api/, '')
  return Object.entries(paths)
    .filter(([axis, p]) => page === p || page.startsWith(`${p}/`) || routes[axis]?.includes(url))
    .map(([axis]) => axis)
}

// ── The matrix and its gaps ──────────────────────────────────────────────────

export interface RouteRow {
  url: string
  cacheName: string | null
  /** Takes `?lab=`, or the lab page or tear sheet already reads it. */
  perLab: boolean
  /** App files (repo-relative) that read it, directly or through a component. */
  readBy: string[]
  labPage: boolean
  tearSheet: boolean
  mcp: boolean
  axes: string[]
}

export interface TableRow {
  /** The SQL name. */
  table: string
  /** The EXPORT_TABLES entries that read it. */
  exportedAs: string[]
}

export interface Gap {
  kind: SurfaceKind
  subject: string
}

export function gapsOf(routes: readonly RouteRow[], tables: readonly TableRow[]): Gap[] {
  const gaps: Gap[] = []
  for (const r of routes) {
    if (r.readBy.length === 0) gaps.push({ kind: 'page', subject: r.url })
    if (r.perLab && !r.labPage) gaps.push({ kind: 'labPage', subject: r.url })
    if (r.perLab && !r.tearSheet) gaps.push({ kind: 'tearSheet', subject: r.url })
    if (!r.mcp) gaps.push({ kind: 'mcp', subject: r.url })
    if (r.axes.length === 0) gaps.push({ kind: 'alerts', subject: r.url })
  }
  for (const t of tables)
    if (t.exportedAs.length === 0) gaps.push({ kind: 'export', subject: t.table })
  return gaps
}

export interface WaiverProblem {
  kind: SurfaceKind | string
  subject: string
  detail: string
}

/**
 * Gaps with no waiver, and waivers that no longer describe a gap: the surface
 * exists now, or the route or table is gone. A reason must be one non-empty line.
 */
export function reconcile(
  gaps: readonly Gap[],
  waivers: Waivers,
): { unwaived: Gap[]; problems: WaiverProblem[] } {
  const open = new Set(gaps.map((g) => `${g.kind}\0${g.subject}`))
  const unwaived = gaps.filter((g) => !waivers[g.kind]?.[g.subject])
  const problems: WaiverProblem[] = []
  for (const [kind, entries] of Object.entries(waivers)) {
    if (!(SURFACE_KINDS as readonly string[]).includes(kind)) {
      problems.push({
        kind,
        subject: '*',
        detail: `not a surface kind (${SURFACE_KINDS.join(', ')})`,
      })
      continue
    }
    for (const [subject, reason] of Object.entries(entries ?? {})) {
      if (!open.has(`${kind}\0${subject}`)) {
        problems.push({
          kind,
          subject,
          detail:
            'stale: the surface exists now, or the route or table is gone. Delete the waiver.',
        })
      } else if (!reason.trim() || reason.includes('\n')) {
        problems.push({ kind, subject, detail: 'a waiver needs a one-line reason' })
      }
    }
  }
  return { unwaived, problems }
}
