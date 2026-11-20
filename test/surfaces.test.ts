// The rules behind `bun run surfaces:check`: how each surface is read out of the
// source, and when a gap or a waiver fails the gate. Pure strings, no filesystem.

import { describe, expect, it } from 'vitest'

import {
  apiFetchPaths,
  axesOfRoute,
  axisPaths,
  axisRoutes,
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
  topLevelArgs,
  transitiveReads,
  type RouteRow,
} from '../scripts/lib/surfaces'

describe('routes', () => {
  it('reads the URL from a GET route file', () => {
    expect(routeUrl('prices.get.ts')).toBe('/api/prices')
    expect(routeUrl('prices/[key].get.ts')).toBe('/api/prices/[key]')
    expect(routeUrl('hiring/history.get.ts')).toBe('/api/hiring/history')
    expect(routeUrl('subscribe/index.get.ts')).toBe('/api/subscribe')
    expect(routeUrl('judge/alerts.post.ts')).toBeNull()
  })

  it('leaves out the writer folders', () => {
    expect(isWriterRoute('judge/pending.get.ts')).toBe(true)
    expect(isWriterRoute('gdelt/work.get.ts')).toBe(true)
    expect(isWriterRoute('subscribe/unsubscribe.get.ts')).toBe(true)
    expect(isWriterRoute('judgement.get.ts')).toBe(false)
  })

  it('finds the cache name, on one line or several', () => {
    expect(routeCacheName("return serveTerminal(event, 'hiring', (ctx) => q(ctx))")).toBe('hiring')
    expect(routeCacheName("serveTerminal(\n    event,\n    'price-history',\n    q)")).toBe(
      'price-history',
    )
    expect(routeCacheName("// serveTerminal(event, 'old')\nreturn 1")).toBeNull()
  })

  it('sees ?lab= in an inline schema or a shared one', () => {
    expect(routeTakesLab('const q = z.object({\n  lab: z.enum(LABS).optional(),\n})')).toBe(true)
    expect(
      routeTakesLab('const { lab } = await getValidatedQuery(event, labQuerySchema.parse)'),
    ).toBe(true)
    expect(routeTakesLab('// ?lab= keeps one lab\nconst x = 1')).toBe(false)
    expect(routeTakesLab('const label = z.string(); const q = { lab_count: z.number() }')).toBe(
      false,
    )
  })
})

describe('MCP', () => {
  it('collects every served cache name, with or without a deps. prefix', () => {
    const source = [
      "await deps.serve('overview', (ctx) => q(ctx))",
      "await deps.serve(\n  'probes',\n  (ctx) => q(ctx))",
      "await read('revenue', as_of, (ctx) => q(ctx))",
      "deps.serveAt('hiring', at, q)",
      "// deps.serve('commented-out', q)",
    ].join('\n')
    expect([...mcpServedNames(source)].sort()).toEqual(['hiring', 'overview', 'probes', 'revenue'])
  })
})

describe('pages', () => {
  it('reads only the script blocks of a .vue file', () => {
    const vue =
      '<script setup>\nuseFetch(\'/api/a\')\n</script>\n<template><NuxtLink to="/api/b" /></template>'
    expect(apiFetchPaths(scriptOf(vue, true))).toEqual(['/api/a'])
  })

  it('finds fetches with generics, template literals and query strings', () => {
    const script = [
      "useFetch<PricesData>('/api/prices', { key: 'x' })",
      'useFetch(\n  `/api/prices/${encodeURIComponent(key)}`,\n)',
      "$fetch('/api/alerts?tier=all')",
      "const label = '/api/not-a-call'",
    ].join('\n')
    expect(apiFetchPaths(script)).toEqual(['/api/prices', '/api/prices/${}', '/api/alerts'])
  })

  it('matches a fetched path to its route, exact before dynamic', () => {
    const urls = ['/api/prices', '/api/prices/[key]', '/api/hiring/history', '/api/alerts/[id]']
    expect(matchRoute('/api/prices', urls)).toBe('/api/prices')
    expect(matchRoute('/api/prices/${}', urls)).toBe('/api/prices/[key]')
    expect(matchRoute('/api/hiring/history', urls)).toBe('/api/hiring/history')
    expect(matchRoute('/api/hiring', urls)).toBeNull()
    expect(matchRoute('/api/alerts/x/y', urls)).toBeNull()
    expect(matchRoute('/api/hiring/history', ['/api/hiring/[id]', '/api/hiring/history'])).toBe(
      '/api/hiring/history',
    )
  })

  it('names components the way Nuxt does', () => {
    expect(componentNameOf('Terminal/Reliability.vue')).toBe('TerminalReliability')
    expect(componentNameOf('Terminal/TerminalGap.vue')).toBe('TerminalGap')
    expect(componentNameOf('Brand/Logo.vue')).toBe('BrandLogo')
    expect(componentNameOf('Thesis/claim-card.vue')).toBe('ThesisClaimCard')
  })

  it('finds rendered components by tag, kebab tag, Lazy prefix or import', () => {
    const source = [
      '<template><TerminalReliability /><LazyTerminalGap /><terminal-strain-table /></template>',
      "<script setup>const X = defineAsyncComponent(() => import('../components/Terminal/Chart.vue'))</script>",
    ].join('\n')
    const refs = componentRefs(source)
    for (const name of [
      'TerminalReliability',
      'TerminalGap',
      'TerminalStrainTable',
      'TerminalChart',
    ]) {
      expect(refs.has(name)).toBe(true)
    }
  })

  it('credits a page with what its components fetch, through nesting and cycles', () => {
    const files = new Map([
      ['page.vue', { reads: ['/api/a'], renders: new Set(['Outer']) }],
      ['Outer.vue', { reads: [], renders: new Set(['Inner']) }],
      ['Inner.vue', { reads: ['/api/b'], renders: new Set(['Outer']) }],
    ])
    const components = new Map([
      ['Outer', 'Outer.vue'],
      ['Inner', 'Inner.vue'],
    ])
    const reads = transitiveReads(files, components)
    expect([...reads.get('page.vue')!].sort()).toEqual(['/api/a', '/api/b'])
  })
})

describe('tables and exports', () => {
  it('reads table declarations', () => {
    const schema =
      "export const latencyProbes = sqliteTable(\n  'latency_probes',\n  {})\nconst notExported = sqliteTable('x', {})"
    expect(tableDecls(schema)).toEqual([{ camel: 'latencyProbes', sql: 'latency_probes' }])
  })

  const views = [
    'export function entityView(name: string, t: string): ExportTable {',
    '  return db.select().from(tables.entities)',
    '}',
    'export function plainTable(name: string, table: SQLiteTable): ExportTable {',
    '  db.select().from(table); db.select().from(tables.sourceStats)',
    '}',
    'export function staticTable(name: string): ExportTable {',
    '  return { rows }',
    '}',
    'export function project(row: Row): Row {',
    '  return db.select().from(tables.changes)',
    '}',
  ].join('\n')

  it('lists the builders that return an ExportTable, with what each body reads', () => {
    const builders = exportBuilders(views)
    expect([...builders.keys()]).toEqual(['entityView', 'plainTable', 'staticTable'])
    expect(builders.get('entityView')).toEqual(['entities'])
  })

  it('takes a bare table argument over what the builder body reads', () => {
    const registry = [
      'export const EXPORT_TABLES = {',
      "  snapshots: plainTable('snapshots', 'd', tables.snapshots, {}, [tables.snapshots.id], byColumn(tables.snapshots.fetched_at), loggedTotal(tables.sourceStats.n)),",
      "  prices_latest: entityView('prices_latest', 'model'),",
      "  entity_securities: staticTable('entity_securities', ['a', 'b']),",
      '}',
    ].join('\n')
    expect(exportEntries(registry, exportBuilders(views))).toEqual([
      { name: 'snapshots', builder: 'plainTable', reads: ['snapshots'] },
      { name: 'prices_latest', builder: 'entityView', reads: ['entities'] },
      { name: 'entity_securities', builder: 'staticTable', reads: [] },
    ])
  })

  it('splits arguments at depth zero only', () => {
    expect(topLevelArgs("(a, { b: 1, c: [2, 3] }, 'd, e', f(g, h))")).toEqual([
      'a',
      '{ b: 1, c: [2, 3] }',
      "'d, e'",
      'f(g, h)',
    ])
  })
})

describe('alert axes', () => {
  const labs =
    "export const AXIS_PATH: Record<AlertAxis, string> = {\n  pricing: '/prices',\n  hiring: '/hiring',\n  sec: '/revenue',\n  revenue: '/revenue',\n}"

  it('puts a route on every axis whose page it sits under', () => {
    const paths = axisPaths(labs)
    expect(axesOfRoute('/api/prices/[key]', paths)).toEqual(['pricing'])
    expect(axesOfRoute('/api/hiring/history', paths)).toEqual(['hiring'])
    expect(axesOfRoute('/api/revenue', paths)).toEqual(['sec', 'revenue'])
    expect(axesOfRoute('/api/pricesx', paths)).toEqual([])
  })

  it('puts a route on an axis whose AXIS_ROUTES entry names it', () => {
    const source = `${labs}\n// compute: ['/api/not-this']\nexport const AXIS_ROUTES: Partial<Record<AlertAxis, readonly string[]>> = {\n  hiring: ['/api/gpu-prices', "/api/pay"],\n}`
    const routes = axisRoutes(source)
    expect(routes).toEqual({ hiring: ['/api/gpu-prices', '/api/pay'] })
    expect(axesOfRoute('/api/gpu-prices', axisPaths(source), routes)).toEqual(['hiring'])
    expect(axesOfRoute('/api/gpu-pricesx', axisPaths(source), routes)).toEqual([])
    expect(axisRoutes(labs)).toEqual({})
  })
})

describe('gaps and waivers', () => {
  const row = (over: Partial<RouteRow>): RouteRow => ({
    url: '/api/x',
    cacheName: 'x',
    perLab: false,
    readBy: ['page.vue'],
    labPage: false,
    tearSheet: false,
    mcp: true,
    axes: ['pricing'],
    ...over,
  })

  it('asks for the lab page and tear sheet only of a per-lab route', () => {
    expect(gapsOf([row({})], [])).toEqual([])
    expect(gapsOf([row({ perLab: true, labPage: true })], [])).toEqual([
      { kind: 'tearSheet', subject: '/api/x' },
    ])
  })

  it('reports every missing surface of a bare route and an unexported table', () => {
    const gaps = gapsOf(
      [row({ readBy: [], mcp: false, axes: [] })],
      [{ table: 't', exportedAs: [] }],
    )
    expect(gaps.map((g) => g.kind)).toEqual(['page', 'mcp', 'alerts', 'export'])
  })

  it('fails an unwaived gap, a stale waiver and an empty reason', () => {
    const gaps = [
      { kind: 'mcp' as const, subject: '/api/a' },
      { kind: 'mcp' as const, subject: '/api/b' },
      { kind: 'export' as const, subject: 'c' },
    ]
    const { unwaived, problems } = reconcile(gaps, {
      mcp: { '/api/a': 'not yet: no tool', '/api/gone': 'internal: removed' },
      export: { c: '  ' },
    })
    expect(unwaived).toEqual([{ kind: 'mcp', subject: '/api/b' }])
    expect(problems.map((p) => [p.subject, p.detail.split(':')[0]])).toEqual([
      ['/api/gone', 'stale'],
      ['c', 'a waiver needs a one-line reason'],
    ])
  })

  it('rejects a waiver under a kind that does not exist', () => {
    const { problems } = reconcile([], { pages: { '/api/a': 'x' } } as never)
    expect(problems).toHaveLength(1)
  })
})
