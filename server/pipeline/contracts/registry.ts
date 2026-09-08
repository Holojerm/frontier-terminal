import type { z } from 'zod'
import { contentHash } from './keys'
import type { ParserId } from './parsers'

// Determinism harness. Every DETERMINISTIC parser registers here; the test
// suite runs each one twice on its committed fixture and the output hashes
// must match — the boundary table's promise made executable. Agent lanes
// (Google pricing, repair path) never register: they are gated by
// agent-gate.ts instead.
//
// No filesystem here: the harness runs inside workerd, and the parsers run
// inside a Worker. Fixture text reaches a parser through a FixtureReader the
// caller supplies (tests build one from raw imports).

/** Returns the text of a committed file by repo-relative path; throws if unknown. */
export type FixtureReader = (repoRelativePath: string) => string

export interface RegisteredParser {
  name: ParserId
  lane: 'hiring' | 'vendor-md' | 'sec' | 'status' | 'cross-check'
  fixturePath: string
  /** Committed files the parser joins against beyond its fixture (a Greenhouse
   * /departments payload, sources.yaml). Declared so the harness serves exactly
   * these and nothing else. */
  sideFixturePaths: readonly string[]
  schema: z.ZodType
  parse: (fixtureText: string, side: FixtureReader) => unknown
}

const registry = new Map<string, RegisteredParser>()

export function registerParser(parser: RegisteredParser): void {
  if (registry.has(parser.name)) {
    throw new Error(`parser already registered: ${parser.name}`)
  }
  registry.set(parser.name, parser)
}

export function registeredParsers(): RegisteredParser[] {
  return [...registry.values()]
}

export function assertDeterministic(
  parser: RegisteredParser,
  read: FixtureReader,
): { hashA: string; hashB: string } {
  const fixture = read(parser.fixturePath)
  const side: FixtureReader = (path) => {
    if (!parser.sideFixturePaths.includes(path)) {
      throw new Error(`parser ${parser.name} reads undeclared side fixture ${path}`)
    }
    return read(path)
  }
  const hashA = contentHash(parser.parse(fixture, side))
  const hashB = contentHash(parser.parse(fixture, side))
  return { hashA, hashB }
}
