// The rules behind `bun run domains:check`: which layer may import which, what
// a domain lets others read, and which auto-imported names clash. Pure strings.

import { describe, expect, it } from 'vitest'

import { DOMAIN_LAYERS } from '../domains.config'
import {
  componentFindings,
  componentName,
  componentRefs,
  declaredExports,
  duplicateNames,
  edgeProblem,
  fileFindings,
  importSpecifiers,
  reachable,
  specifierTarget,
  tableProblems,
  type LayerTable,
} from '../scripts/lib/domains'

const TABLE: LayerTable = {
  core: { uses: [] },
  compute: { uses: ['core'], public: ['server/utils/terminal-gpu.ts'] },
  theses: { uses: ['compute'] },
  terminal: { uses: ['theses', 'core'] },
}

describe('the domain table', () => {
  it('reaches what its uses reach, transitively', () => {
    expect([...reachable(TABLE, 'terminal')].sort()).toEqual(['compute', 'core', 'theses'])
    expect([...reachable(TABLE, 'core')]).toEqual([])
  })

  it('names every layer on disk, and only those, without a cycle', () => {
    expect(tableProblems(TABLE, ['core', 'compute', 'theses', 'terminal'])).toEqual([])
    expect(tableProblems(TABLE, ['core', 'compute', 'theses', 'terminal', 'pricing'])).toEqual([
      'layers/pricing is not in the domain table',
    ])
    expect(tableProblems({ a: { uses: ['b'] }, b: { uses: ['a'] } }, ['a', 'b'])).toEqual([
      'a depends on itself through its uses',
      'b depends on itself through its uses',
    ])
  })

  it('matches the layers this repo has', () => {
    expect(
      tableProblems(DOMAIN_LAYERS, [
        'adoption',
        'compute',
        'core',
        'models',
        'pricing',
        'reliability',
        'talent',
        'terminal',
      ]),
    ).toEqual([])
    expect(DOMAIN_LAYERS.core.uses).toEqual([])
    expect(DOMAIN_LAYERS.compute.uses).toEqual(['core'])
    expect(DOMAIN_LAYERS.pricing.uses).toEqual(['core'])
    expect(DOMAIN_LAYERS.talent.uses).toEqual(['core'])
    expect(DOMAIN_LAYERS.reliability.uses).toEqual(['core', 'pricing'])
    expect(DOMAIN_LAYERS.adoption.uses).toEqual(['core', 'reliability'])
    expect(DOMAIN_LAYERS.models.uses).toEqual(['core', 'pricing'])
  })
})

describe('edgeProblem', () => {
  it('lets a layer import down the table and never up it', () => {
    expect(edgeProblem(TABLE, 'layers/terminal/server/a.ts', 'layers/core/server/b.ts')).toBeNull()
    expect(edgeProblem(TABLE, 'layers/core/server/a.ts', 'layers/terminal/server/b.ts')).toMatch(
      /core may not import terminal/,
    )
  })

  it('opens only shared/ and the public list of a domain', () => {
    const from = 'layers/theses/server/x.ts'
    expect(edgeProblem(TABLE, from, 'layers/compute/shared/utils/gpu.ts')).toBeNull()
    expect(edgeProblem(TABLE, from, 'layers/compute/server/utils/terminal-gpu.ts')).toBeNull()
    expect(edgeProblem(TABLE, from, 'layers/compute/server/pipeline/floor.ts')).toMatch(
      /not on compute's public list/,
    )
  })

  it('leaves the app root, tests and unknown layers alone', () => {
    expect(
      edgeProblem(TABLE, 'server/registries/lanes.ts', 'layers/terminal/server/a.ts'),
    ).toBeNull()
    expect(
      edgeProblem(TABLE, 'layers/core/test/a.test.ts', 'layers/terminal/server/a.ts'),
    ).toBeNull()
    expect(edgeProblem(TABLE, 'layers/core/server/a.ts', 'layers/social/server/a.ts')).toBeNull()
  })
})

describe('importSpecifiers and specifierTarget', () => {
  it('reads static, dynamic, re-export, raw and mock specifiers, not commented ones', () => {
    const source = [
      "import { a } from './a'",
      "export * from '#layers/core/server/b'",
      "const c = await import('../c')",
      "import d from 'raw:~~/sources.yaml'",
      "vi.mock('../../e')",
      "// import { f } from './f'",
      "const s = 'from ./g'",
    ].join('\n')
    expect(importSpecifiers(source).map((s) => s.spec)).toEqual([
      './a',
      '#layers/core/server/b',
      '../c',
      'raw:~~/sources.yaml',
      '../../e',
    ])
  })

  it('resolves relative and layer aliases to repo paths, and leaves packages alone', () => {
    const file = 'layers/core/server/utils/x.ts'
    expect(specifierTarget(file, '../../../terminal/server/y')).toBe('layers/terminal/server/y')
    expect(specifierTarget(file, '#layers/terminal/server/y')).toBe('layers/terminal/server/y')
    expect(specifierTarget(file, '~~/layers/terminal/y?raw')).toBe('layers/terminal/y')
    expect(specifierTarget(file, '#server/registries/lanes')).toBeNull()
    expect(specifierTarget(file, 'drizzle-orm')).toBeNull()
  })
})

describe('auto-imported names', () => {
  it('counts what a module declares, not what it re-exports', () => {
    const source = [
      'export const A = 1',
      'export async function b() {}',
      'export interface C {}',
      'export type D = string',
      'const e = 2',
      'export { e, e as f }',
      "export { g } from './g'",
      "export * from './h'",
    ].join('\n')
    expect(declaredExports(source)).toEqual(['A', 'C', 'D', 'b', 'e', 'f'])
  })

  it('flags a name two owners define, not two files of one owner', () => {
    expect(
      duplicateNames([
        { name: 'clash', file: 'layers/core/server/utils/a.ts' },
        { name: 'clash', file: 'layers/terminal/server/utils/b.ts' },
        { name: 'local', file: 'layers/terminal/server/utils/c.ts' },
        { name: 'local', file: 'layers/terminal/server/utils/d.ts' },
        { name: 'root', file: 'server/utils/e.ts' },
        { name: 'root', file: 'layers/core/shared/utils/f.ts' },
      ]),
    ).toEqual([
      {
        name: 'clash',
        files: ['layers/core/server/utils/a.ts', 'layers/terminal/server/utils/b.ts'],
      },
      { name: 'root', files: ['layers/core/shared/utils/f.ts', 'server/utils/e.ts'] },
    ])
  })
})

describe('fileFindings', () => {
  const resolve = (target: string) => `${target}.ts`
  const auto = new Map([
    ['queryPrices', 'layers/terminal/server/utils/terminal-prices.ts'],
    ['served', 'layers/core/server/utils/terminal-envelope.ts'],
  ])

  it('reports an explicit and an auto-import edge against the table, once per name', () => {
    const findings = fileFindings(
      TABLE,
      'layers/core/server/utils/x.ts',
      "import { LANES } from '#layers/terminal/server/pipeline/lanes'\n",
      resolve,
      [
        { name: 'queryPrices', line: 4 },
        { name: 'queryPrices', line: 9 },
        { name: 'served', line: 5 },
      ],
      auto,
    )
    expect(findings.map((f) => [f.line, f.message.split(':')[0]])).toEqual([
      [1, 'imports #layers/terminal/server/pipeline/lanes'],
      [4, 'uses queryPrices (auto-imported from layers/terminal/server/utils/terminal-prices.ts)'],
    ])
  })
})

describe('auto-registered components', () => {
  it('names a component the way Nuxt does', () => {
    expect(componentName('Terminal/Table.vue')).toBe('TerminalTable')
    expect(componentName('Terminal/TerminalTable.vue')).toBe('TerminalTable')
    expect(componentName('TearSheet/Gap.vue')).toBe('TearSheetGap')
    expect(componentName('Brand/Logo.vue')).toBe('BrandLogo')
    expect(componentName('price-matrix/index.vue')).toBe('PriceMatrix')
  })

  it('reads the template tags, PascalCase or kebab, without Lazy, and never a type argument', () => {
    const source = [
      '<script setup lang="ts">',
      'const rows = ref<TerminalGap[]>([])',
      '</script>',
      '<template>',
      '  <TerminalPage>',
      '    <LazyTerminalTable />',
      '    <terminal-panel />',
      '    <div />',
      '  </TerminalPage>',
      '</template>',
    ].join('\n')
    expect(componentRefs(source)).toEqual([
      { name: 'TerminalPage', line: 5 },
      { name: 'TerminalTable', line: 6 },
      { name: 'TerminalPanel', line: 7 },
    ])
  })

  it('flags a component from a layer the file may not use, and nothing else', () => {
    const defined = new Map([
      ['TerminalTable', 'layers/core/app/components/Terminal/Table.vue'],
      ['TerminalGpuMedians', 'layers/compute/app/components/Terminal/GpuMedians.vue'],
      ['TerminalReadoutStrip', 'layers/terminal/app/components/Terminal/ReadoutStrip.vue'],
      ['BrandLogo', 'app/components/Brand/Logo.vue'],
    ])
    const page = '<template><TerminalTable /><TerminalReadoutStrip /><BrandLogo /></template>'
    expect(componentFindings(TABLE, 'layers/compute/app/pages/compute.vue', page, defined)).toEqual(
      [
        {
          file: 'layers/compute/app/pages/compute.vue',
          line: 1,
          message: expect.stringContaining('compute may not use terminal'),
        },
      ],
    )
    const shell = '<template><TerminalGpuMedians /><TerminalTable /></template>'
    expect(componentFindings(TABLE, 'layers/terminal/app/pages/x.vue', shell, defined)).toEqual([])
    expect(componentFindings(TABLE, 'layers/core/test/x.vue', page, defined)).toEqual([])
  })

  it('flags a component name two owners register', () => {
    expect(
      duplicateNames([
        { name: 'TerminalTable', file: 'layers/core/app/components/Terminal/Table.vue' },
        { name: 'TerminalTable', file: 'layers/terminal/app/components/Terminal/Table.vue' },
      ]),
    ).toHaveLength(1)
  })
})
