// Surfaces gate — run with `bun run surfaces:check`, wired into `bun run ci` and `ci:fast`.
//
// A dataset added to the store has to reach every place a reader looks for it:
// a page, the lab page and tear sheet when it is per lab, an MCP tool, the bulk
// export, and an alert axis. Datasets added in November reached their own page
// and nothing else, and no gate noticed. This one derives the matrix from the
// code (scripts/lib/surfaces.ts says how each surface is read), and fails on a
// gap that surfaces.waivers.ts does not name, or on a waiver whose gap is gone.
//
//   bun run surfaces:check            # the gate
//   bun run surfaces:check --matrix   # print every route and table, gaps marked
//
// Rules and how to waive: .claude/docs/surfaces.md.

import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { SURFACE_WAIVERS } from '../surfaces.waivers'

import {
  SURFACE_LABEL,
  apiFetchPaths,
  axesOfRoute,
  axisRoutes,
  axisPaths,
  componentNameOf,
  componentRefs,
  exportBuilders,
  exportEntries,
  gapsOf,
  isWriterRoute,
  matchRoute,
  mcpServedNames,
  reconcile,
  routeCacheName,
  routeTakesLab,
  routeUrl,
  scriptOf,
  tableDecls,
  transitiveReads,
  type RouteRow,
  type TableRow,
} from './lib/surfaces'
import { walk } from './lib/walk'

const ROOT = resolve(import.meta.dir, '..')
const LAYER = join(ROOT, 'layers/terminal')
const read = (file: string) => readFileSync(file, 'utf8')
const rel = (file: string) => relative(ROOT, file)
const ts = { extensions: ['.ts'], missingOk: true } as const

// One file per domain for each: MCP tools, export tables, schema tables.
const MCP_FILES = walk(join(LAYER, 'server/mcp'), ts)
const EXPORT_FILES = walk(join(LAYER, 'server/export-tables'), ts)
const SCHEMA_FILES = walk(join(LAYER, 'server/db/tables'), ts)
const VIEWS_FILE = join(LAYER, 'server/utils/terminal-export-views.ts')
const LABS_FILE = join(LAYER, 'shared/utils/terminal-labs.ts')
const LAB_PAGE = join(LAYER, 'app/pages/labs/[lab]/index.vue')
const TEAR_SHEET = join(LAYER, 'app/pages/labs/[lab]/tear-sheet.vue')

const broken: string[] = []
if (MCP_FILES.length === 0) broken.push('no MCP tool files found')
if (EXPORT_FILES.length === 0) broken.push('no export registry found')
if (SCHEMA_FILES.length === 0) broken.push('no schema found')
for (const f of [VIEWS_FILE, LABS_FILE, LAB_PAGE, TEAR_SHEET]) {
  if (!existsSync(f)) broken.push(`${rel(f)} is missing`)
}
if (broken.length) {
  console.error(`surfaces:check cannot read the code it checks:\n  ${broken.join('\n  ')}`)
  console.error('A file moved: update the paths at the top of scripts/check-surfaces.ts.')
  process.exit(1)
}

// ── Routes ───────────────────────────────────────────────────────────────────
const API = join(LAYER, 'server/api')
const routes = walk(API, ts)
  .map((file) => ({ file, relApi: relative(API, file) }))
  .filter(({ relApi }) => !isWriterRoute(relApi))
  .flatMap(({ file, relApi }) => {
    const url = routeUrl(relApi)
    return url ? [{ file, url, source: read(file) }] : []
  })
const urls = routes.map((r) => r.url)

// ── Pages and components ─────────────────────────────────────────────────────
const appDirs = [join(ROOT, 'app'), join(LAYER, 'app')]
const appFiles = appDirs.flatMap((d) => walk(d, { extensions: ['.vue', '.ts'], missingOk: true }))
const components = new Map<string, string>()
for (const dir of appDirs) {
  for (const file of walk(join(dir, 'components'), { extensions: ['.vue'], missingOk: true })) {
    components.set(componentNameOf(relative(join(dir, 'components'), file)), file)
  }
}
const direct = new Map<string, { reads: string[]; renders: Set<string> }>()
for (const file of appFiles) {
  const source = read(file)
  const reads = apiFetchPaths(scriptOf(source, file.endsWith('.vue')))
    .map((p) => matchRoute(p, urls))
    .filter((u): u is string => u !== null)
  direct.set(file, { reads, renders: componentRefs(source) })
}
const readsOf = transitiveReads(direct, components)
const readers = new Map<string, string[]>()
for (const [file, reads] of readsOf) {
  for (const url of reads) readers.set(url, [...(readers.get(url) ?? []), rel(file)])
}
const labReads = readsOf.get(LAB_PAGE) ?? new Set()
const tearReads = readsOf.get(TEAR_SHEET) ?? new Set()

// ── MCP and axes ─────────────────────────────────────────────────────────────
const served = new Set(MCP_FILES.flatMap((f) => [...mcpServedNames(read(f))]))
const axes = axisPaths(read(LABS_FILE))
const extraRoutes = axisRoutes(read(LABS_FILE))

const routeRows: RouteRow[] = routes
  .map(({ url, source }): RouteRow => {
    const cacheName = routeCacheName(source)
    const labPage = labReads.has(url)
    const tearSheet = tearReads.has(url)
    return {
      url,
      cacheName,
      perLab: routeTakesLab(source) || labPage || tearSheet,
      readBy: (readers.get(url) ?? []).sort(),
      labPage,
      tearSheet,
      mcp: cacheName !== null && served.has(cacheName),
      axes: axesOfRoute(url, axes, extraRoutes),
    }
  })
  .sort((a, b) => a.url.localeCompare(b.url))

// ── Tables ───────────────────────────────────────────────────────────────────
const decls = SCHEMA_FILES.flatMap((f) => tableDecls(read(f)))
const builders = exportBuilders(read(VIEWS_FILE))
const entries = EXPORT_FILES.flatMap((f) => exportEntries(read(f), builders))
const tableRows: TableRow[] = decls
  .map(({ camel, sql }) => ({
    table: sql,
    exportedAs: entries.filter((e) => e.reads.includes(camel)).map((e) => e.name),
  }))
  .sort((a, b) => a.table.localeCompare(b.table))

if (routeRows.length === 0 || tableRows.length === 0 || entries.length === 0) {
  console.error(
    `surfaces:check read ${routeRows.length} route(s), ${tableRows.length} table(s), ${entries.length} export(s): ` +
      'a parser no longer matches the code. Fix scripts/lib/surfaces.ts before trusting a pass.',
  )
  process.exit(1)
}

// ── Report ───────────────────────────────────────────────────────────────────
const gaps = gapsOf(routeRows, tableRows)
const { unwaived, problems } = reconcile(gaps, SURFACE_WAIVERS)

if (process.argv.includes('--matrix')) {
  const mark = (ok: boolean, na = false) => (na ? '·' : ok ? '✓' : '✗')
  console.info('route                         page lab  tear mcp  alert  cache')
  for (const r of routeRows) {
    console.info(
      `${r.url.padEnd(30)}${mark(r.readBy.length > 0).padEnd(5)}${mark(r.labPage, !r.perLab).padEnd(5)}` +
        `${mark(r.tearSheet, !r.perLab).padEnd(5)}${mark(r.mcp).padEnd(5)}${(r.axes.join(',') || '✗').padEnd(7)}${r.cacheName ?? '-'}`,
    )
  }
  console.info('\ntable                         exported as')
  for (const t of tableRows) console.info(`${t.table.padEnd(30)}${t.exportedAs.join(', ') || '✗'}`)
  console.info('')
}

if (unwaived.length === 0 && problems.length === 0) {
  console.info(
    `surfaces:check — ${routeRows.length} routes, ${tableRows.length} tables; ${gaps.length} gap(s), each waived`,
  )
  process.exit(0)
}

console.error(`\nsurfaces:check failed — ${unwaived.length + problems.length} problem(s)\n`)
for (const g of unwaived) console.error(`  ${g.kind}  ${g.subject}  ${SURFACE_LABEL[g.kind]}`)
for (const p of problems) console.error(`  ${p.kind}  ${p.subject}  waiver: ${p.detail}`)
console.error(
  '\nA dataset reaches every surface, or surfaces.waivers.ts says why not, in one line.\n' +
    'Add the missing surface, or the waiver; delete a stale waiver. `--matrix` prints the\n' +
    'whole table. How: .claude/docs/surfaces.md.\n',
)
process.exit(1)
