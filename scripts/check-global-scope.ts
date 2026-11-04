// Global-scope gate — run with `bun run globals:check`, wired into `bun run ci`.
//
// Fails on server code that, at module load, generates random values, sets a
// timer, fetches, or reads the clock: crypto.randomUUID, crypto.getRandomValues,
// Math.random, setTimeout, setInterval, fetch, Date.now and an argument-less
// new Date(). Workers refuse the first five at deploy (error 10021), after CI
// has passed: #169 shipped `const usage = createUsageCounter()` at module scope,
// the factory's default parameter called crypto.randomUUID(), and main stopped
// deploying until #170. The clock reads are not refused, only wrong.
//
// A module-scope call to a function this file declares or imports by a relative
// or alias path (#server, #shared, #layers, ~~, ~) is followed up to three
// calls deep: its omitted parameters' defaults and its body run at load too.
// Not followed: a Nuxt auto-import called without an import, a method call
// (obj.make()), a package, or a re-export. Escape hatch: `global-scope-ok` in a
// comment on the flagged line or the line above, saying why.
//
// Scans server/ and every layers/*/server/, skipping tests.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { globalScopeFindings, runSelfTest, type SourceHost } from './lib/global-scope'
import { walk } from './lib/walk'

const ROOT = resolve(import.meta.dir, '..')

const selfTest = runSelfTest()
if (selfTest.length) {
  console.error('\nglobals:check failed its self-test, so its scan cannot be trusted:\n')
  for (const failure of selfTest) console.error(`  ${failure}`)
  console.error('\nFix scripts/lib/global-scope.ts until SELF_TEST passes.\n')
  process.exit(1)
}

const ALIASES: readonly [string, string][] = [
  ['#server/', join(ROOT, 'server')],
  ['#shared/', join(ROOT, 'shared')],
  ['#layers/', join(ROOT, 'layers')],
  ['~~/', ROOT],
  ['~/', ROOT],
]

const host: SourceHost = {
  read: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
  resolve: (from, specifier) => {
    let base: string | null = null
    if (specifier.startsWith('.')) base = join(dirname(from), specifier)
    for (const [prefix, dir] of ALIASES) {
      if (specifier.startsWith(prefix)) base = join(dir, specifier.slice(prefix.length))
    }
    if (!base) return null
    return (
      [`${base}.ts`, join(base, 'index.ts'), base].find(
        (p) => p.endsWith('.ts') && existsSync(p),
      ) ?? null
    )
  },
}

const layersDir = join(ROOT, 'layers')
const roots = [
  join(ROOT, 'server'),
  ...(existsSync(layersDir)
    ? readdirSync(layersDir).map((name) => join(layersDir, name, 'server'))
    : []),
].filter((dir) => existsSync(dir))

const files = roots
  .flatMap((dir) => walk(dir, { extensions: ['.ts'], skip: (name) => name === 'node_modules' }))
  .filter((file) => !/\.(test|spec)\.ts$/.test(file) && !file.endsWith('.d.ts'))

const problems = files.flatMap((file) =>
  globalScopeFindings(host, file).map(
    (f) => `${relative(ROOT, f.file)}:${f.line}  ${f.call} at module load: ${f.why}`,
  ),
)

if (problems.length === 0) {
  console.info(
    `globals:check — ${files.length} server module(s), nothing runs at load that Workers refuse`,
  )
  process.exit(0)
}

console.error(`\nglobals:check failed — ${problems.length} problem(s)\n`)
for (const problem of problems) console.error(`  ${problem}`)
console.error(
  '\nMove the call to first use, as #170 did: `let counter: T | null = null` and\n' +
    '`const usage = () => (counter ??= createUsageCounter())`, or pass the value in from a\n' +
    'request or a task. If it truly runs at load and is safe, add `// global-scope-ok: <why>`.\n',
)
process.exit(1)
