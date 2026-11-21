// The rules behind `bun run domains:check`: which layer may import which, what
// a domain lets others read, and which auto-imported names clash. Pure strings.

import { describe, expect, it } from 'vitest'

import { DOMAIN_LAYERS } from '../domains.config'
import {
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
    expect(tableProblems(DOMAIN_LAYERS, ['core', 'terminal'])).toEqual([])
    expect(DOMAIN_LAYERS.core.uses).toEqual([])
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
