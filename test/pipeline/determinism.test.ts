import { describe, expect, test } from 'vitest'

import {
  assertDeterministic,
  parserOutputSchemas,
  registeredParsers,
  type ParserId,
} from '../../server/pipeline/contracts'
import '../../server/pipeline/parsers.manifest'
import { fixtureText, manifest } from './fixtures'

// Determinism gate: every registered parser, run twice on its committed
// fixture, must produce byte-identical output hashes. This is the boundary
// table's "deterministic" promise, executed — with no filesystem in the loop.

// Every parser id with an output schema is a fixed parser — Google's pricing
// page included, since 2026-09-07. The judge lane has no parser id; it is
// gated by parseAgentOutput, never by this harness.
describe('determinism gate', () => {
  test('every parser id is registered', () => {
    const expected = (Object.keys(parserOutputSchemas) as ParserId[]).sort()
    expect(
      registeredParsers()
        .map((p) => p.name)
        .sort(),
    ).toEqual(expected)
  })

  test('every registered fixture is a committed file recorded in fixtures/manifest.json', () => {
    const recorded = new Set(manifest.fixtures.map((f) => f.path))
    for (const p of registeredParsers()) {
      expect(recorded).toContain(p.fixturePath)
      for (const side of p.sideFixturePaths) {
        if (side !== 'sources.yaml') expect(recorded).toContain(side)
      }
    }
  })

  test.each(registeredParsers().map((p) => [p.name, p] as const))(
    'parser %s is deterministic on its fixture and validates against its registered schema',
    (_name, parser) => {
      const { hashA, hashB } = assertDeterministic(parser, fixtureText)
      expect(hashA).toBe(hashB)
      const out = parser.parse(fixtureText(parser.fixturePath), fixtureText)
      expect(parser.schema.safeParse(out).success).toBe(true)
    },
  )

  test('a parser reaching for a side fixture it did not declare is refused', () => {
    const fts = registeredParsers().find((p) => p.name === 'edgar-fts')!
    const undeclared = { ...fts, sideFixturePaths: [] }
    expect(() => assertDeterministic(undeclared, fixtureText)).toThrow(
      'parser edgar-fts reads undeclared side fixture sources.yaml',
    )
  })
})
