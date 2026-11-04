// The analysis half of `bun run globals:check` (scripts/check-global-scope.ts).
//
// Workers evaluate every module once, in global scope, before any request, and
// refuse a deploy whose global scope generates random values, sets a timer or
// does I/O (Cloudflare error 10021, "Disallowed operation called within global
// scope"). Clocks are not refused but read the Unix epoch there, so a
// timestamp taken at load is silently wrong. Dev, vitest and the build all run
// the same code happily; only the deploy says no.
//
// Uses the TypeScript parser already installed for vue-tsc. It cannot load in
// workerd, so the gate proves itself on SELF_TEST before scanning, on every run,
// instead of in vitest.

import ts from 'typescript'

/** Calls Workers refuse, or answer wrongly, at module load. Keyed by callee text. */
const FORBIDDEN_CALLS: Readonly<Record<string, string>> = {
  'crypto.randomUUID': 'random values are refused in global scope (deploy error 10021)',
  'crypto.getRandomValues': 'random values are refused in global scope (deploy error 10021)',
  'Math.random': 'random values are refused in global scope (deploy error 10021)',
  setTimeout: 'timers are refused in global scope (deploy error 10021)',
  setInterval: 'timers are refused in global scope (deploy error 10021)',
  fetch: 'I/O is refused in global scope (deploy error 10021)',
  'Date.now': 'the clock reads 1970-01-01 in global scope, so the value is wrong',
}
const NEW_DATE = 'the clock reads 1970-01-01 in global scope, so the value is wrong'

/** A comment carrying this on the flagged line or the line above silences it. */
export const IGNORE_MARK = 'global-scope-ok'

/** How many factory calls deep a module-scope call is followed. */
const MAX_DEPTH = 3

export interface Finding {
  file: string
  line: number
  /** What runs at load, e.g. `crypto.randomUUID()` or `createUsageCounter() → crypto.randomUUID()`. */
  call: string
  why: string
}

export interface SourceHost {
  read(file: string): string | null
  /** The file an import specifier names, or null when it is a package or cannot be found. */
  resolve(fromFile: string, specifier: string): string | null
}

type FunctionLike = ts.FunctionLikeDeclaration

const parsed = new Map<string, ts.SourceFile | null>()

function parse(host: SourceHost, file: string): ts.SourceFile | null {
  if (!parsed.has(file)) {
    const text = host.read(file)
    parsed.set(
      file,
      text === null ? null : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
    )
  }
  return parsed.get(file)!
}

function calleeText(expr: ts.Expression): string {
  return expr
    .getText()
    .replace(/^globalThis\./, '')
    .replace(/\s+/g, '')
}

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

/** A class member whose initializer waits for `new` rather than running at load. */
function isDeferredMember(node: ts.Node): boolean {
  return (
    ts.isPropertyDeclaration(node) &&
    !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
  )
}

/** The function an identifier names, in this file or through a resolvable import. */
function declarationOf(
  host: SourceHost,
  sf: ts.SourceFile,
  name: string,
  seen: Set<string> = new Set(),
): { fn: FunctionLike; sf: ts.SourceFile } | null {
  const key = `${sf.fileName}#${name}`
  if (seen.has(key)) return null
  seen.add(key)
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name && stmt.body) {
      return { fn: stmt, sf }
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          return { fn: d.initializer, sf }
        }
      }
    }
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      for (const el of stmt.importClause.namedBindings.elements) {
        if (el.name.text !== name || el.isTypeOnly) continue
        const target = host.resolve(sf.fileName, stmt.moduleSpecifier.text)
        const targetSf = target ? parse(host, target) : null
        const exported = (el.propertyName ?? el.name).text
        return targetSf ? declarationOf(host, targetSf, exported, seen) : null
      }
    }
  }
  return null
}

/**
 * Walk `root` as code that runs now: everything outside a function body or a
 * non-static class field (a function is a value until called). `onRun` hears
 * each call and `new` that runs.
 */
function walkImmediate(root: ts.Node, onRun: (node: ts.CallExpression | ts.NewExpression) => void) {
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node) || isDeferredMember(node)) return
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) onRun(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
}

/** What `fn` runs when called with `argCount` arguments: omitted parameters' defaults, then its body. */
function runsOnCall(fn: FunctionLike, argCount: number): ts.Node[] {
  const out: ts.Node[] = []
  fn.parameters.forEach((p, i) => {
    if (p.initializer && i >= argCount) out.push(p.initializer)
  })
  if (fn.body) out.push(fn.body)
  return out
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function ignored(sf: ts.SourceFile, line: number): boolean {
  const lines = sf.text.split('\n')
  return [lines[line - 1], lines[line - 2]].some((l) => l?.includes(IGNORE_MARK))
}

/** Every forbidden operation `file` performs at module load, directly or through a factory it calls. */
export function globalScopeFindings(host: SourceHost, file: string): Finding[] {
  const sf = parse(host, file)
  if (!sf) return []
  const findings: Finding[] = []

  const inspect = (
    roots: ts.Node[],
    rootSf: ts.SourceFile,
    site: { line: number; chain: string[] } | null,
    depth: number,
  ) => {
    for (const root of roots) {
      walkImmediate(root, (node) => {
        const line = site?.line ?? lineOf(rootSf, node)
        const report = (call: string, why: string) => {
          if (!ignored(sf, line)) {
            findings.push({ file, line, call: [...(site?.chain ?? []), call].join(' → '), why })
          }
        }
        if (ts.isNewExpression(node)) {
          if (calleeText(node.expression) === 'Date' && !node.arguments?.length) {
            report('new Date()', NEW_DATE)
          }
          return
        }
        const callee = calleeText(node.expression)
        const why = FORBIDDEN_CALLS[callee]
        if (why) {
          report(`${callee}()`, why)
          return
        }
        if (depth >= MAX_DEPTH || !ts.isIdentifier(node.expression)) return
        const target = declarationOf(host, rootSf, node.expression.text)
        if (!target) return
        inspect(
          runsOnCall(target.fn, node.arguments.length),
          target.sf,
          { line, chain: [...(site?.chain ?? []), `${callee}()`] },
          depth + 1,
        )
      })
    }
  }

  inspect([...sf.statements], sf, null, 0)
  return findings
}

/** Forget parsed files, so a host's later edits are read afresh. */
export function resetGlobalScopeCache(): void {
  parsed.clear()
}

/**
 * Cases the gate must get right before its scan is trusted. The first is
 * #169's: a module-scope `const usage = createUsageCounter()` whose factory's
 * default parameter calls crypto.randomUUID().
 */
export const SELF_TEST: readonly {
  name: string
  files: Readonly<Record<string, string>>
  expect: readonly string[]
}[] = [
  {
    name: 'a factory default parameter, imported (#169)',
    files: {
      'utils/api-access.ts':
        "import { createUsageCounter } from './api-key-usage'\nconst usage = createUsageCounter()\n",
      'utils/api-key-usage.ts':
        'export function createUsageCounter(\n  isolate: string = crypto.randomUUID().slice(0, 8),\n) {\n  return { isolate }\n}\n',
    },
    expect: ['createUsageCounter() → crypto.randomUUID()'],
  },
  {
    name: 'the same factory made lazily (#170)',
    files: {
      'utils/api-access.ts':
        "import { createUsageCounter } from './api-key-usage'\nlet counter = null\nconst usage = () => (counter ??= createUsageCounter())\n",
      'utils/api-key-usage.ts':
        'export function createUsageCounter(isolate = crypto.randomUUID()) {\n  return { isolate }\n}\n',
    },
    expect: [],
  },
  {
    name: 'the factory given the argument its default would make',
    files: {
      'a.ts': "import { make } from './b'\nconst c = make('fixed')\n",
      'b.ts': 'export const make = (id = crypto.randomUUID()) => ({ id })\n',
    },
    expect: [],
  },
  {
    name: 'direct calls at load, and the same inside functions',
    files: {
      'a.ts': [
        'const id = crypto.randomUUID()',
        'const n = Math.random()',
        'const bytes = crypto.getRandomValues(new Uint8Array(4))',
        'const t = Date.now()',
        'const d = new Date()',
        "const fixed = new Date('2026-01-01')",
        'setTimeout(() => {}, 0)',
        'setInterval(() => {}, 1000)',
        "const r = await fetch('https://example.com')",
        'const cfg = { at: Date.now() } // global-scope-ok: deliberate, in a test',
        'export function later() { return [crypto.randomUUID(), Date.now(), new Date()] }',
        'export const lazy = () => Math.random()',
        'class A { x = Math.random(); static y = Math.random(); m() { return fetch("x") } }',
        'export default defineEventHandler(async () => fetch("x"))',
      ].join('\n'),
    },
    expect: [
      'crypto.randomUUID()',
      'Math.random()',
      'crypto.getRandomValues()',
      'Date.now()',
      'new Date()',
      'setTimeout()',
      'setInterval()',
      'fetch()',
      'Math.random()',
    ],
  },
  {
    name: 'a factory whose body, not its parameters, does the work',
    files: {
      'a.ts': 'function seed() { return Math.random() }\nconst s = seed()\n',
    },
    expect: ['seed() → Math.random()'],
  },
]

/** Run SELF_TEST; returns one line per case the analysis gets wrong. */
export function runSelfTest(): string[] {
  const failures: string[] = []
  for (const c of SELF_TEST) {
    resetGlobalScopeCache()
    const host: SourceHost = {
      read: (f) => c.files[f] ?? null,
      resolve: (from, spec) => {
        if (!spec.startsWith('.')) return null
        const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
        const path = `${dir}${spec.replace(/^\.\//, '')}.ts`
        return path in c.files ? path : null
      },
    }
    const entry = Object.keys(c.files)[0]!
    const got = globalScopeFindings(host, entry).map((f) => f.call)
    if (JSON.stringify(got) !== JSON.stringify(c.expect)) {
      failures.push(`${c.name}: expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`)
    }
  }
  resetGlobalScopeCache()
  return failures
}
