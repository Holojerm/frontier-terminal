// Reference gate — run with `bun run mirror:check`, wired into `bun run ci`.
//
// Every file, symbol, and variable a comment or doc names must still exist.
// See scripts/lib/check-references.ts for the rule and for why it is narrow on
// purpose.
//
// A stale cross-reference is not a style problem: an agent reads it, trusts it,
// and goes looking for something that is not there. So it fails the build.
//
// Why a gate script and not a test: the vitest suite runs inside workerd, which
// has no filesystem. This runs in Bun, where it can walk the repo.
//
// The script keeps its historical name. The template it came from also checked
// two hand-mirrored implementations against each other here (the app and a
// second Worker that could not import it); this fork has one Worker, so only
// the reference pass remains.

import { resolve } from 'node:path'

import { findDeadReferences } from './lib/check-references'

const ROOT = resolve(import.meta.dir, '..')

const dead = findDeadReferences(ROOT)

if (dead.length === 0) {
  console.info('mirror:check — every named reference resolves')
  process.exit(0)
}

console.error(`\nmirror:check failed — ${dead.length} dead reference(s)\n`)
for (const ref of dead) {
  console.error(`  ${ref.file}:${ref.line}  \`${ref.token}\` — ${ref.why}`)
}
console.error(
  '\nA comment or doc names something this repo no longer contains. Fix the name,\n' +
    'or drop the reference — a confident pointer to nothing costs the next agent\n' +
    'more than no pointer at all. Deliberate exception: add `refs-check-ignore` to\n' +
    'the line.\n',
)
process.exit(1)
