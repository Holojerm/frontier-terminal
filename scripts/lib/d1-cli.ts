// What the owner's D1 CLIs (scripts/keys.ts, scripts/webhooks.ts) share:
// flag parsing, SQL literals, and running a statement against the local dev
// database or, with --remote, production D1 through `wrangler d1 execute`.
//
// Local means .data/db/sqlite.db, the file `bun dev` serves
// (.claude/docs/gotchas.md › local D1 lives in two places).

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const ROOT = join(import.meta.dir, '../..')
const LOCAL_DB = join(ROOT, '.data/db/sqlite.db')
const D1_NAME = 'frontier-terminal-db'

export type Row = Record<string, unknown>

export function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

export function parseArgs(argv: string[]): {
  command: string
  flags: Map<string, string | true>
} {
  const [command = '', ...rest] = argv.filter((a) => a !== '--')
  const flags = new Map<string, string | true>()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`)
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next)
      i++
    } else {
      flags.set(arg.slice(2), true)
    }
  }
  return { command, flags }
}

/** A SQL string literal. The values here are the owner's own input, quoted all the same. */
export const lit = (value: string | number | null) =>
  value === null
    ? 'NULL'
    : typeof value === 'number'
      ? String(value)
      : `'${value.replace(/'/g, "''")}'`

function runRemote(sql: string): Row[] {
  const result = Bun.spawnSync(
    ['bunx', 'wrangler', 'd1', 'execute', D1_NAME, '--remote', '--json', '--command', sql],
    { cwd: ROOT, stderr: 'inherit' },
  )
  if (result.exitCode !== 0) fail('wrangler d1 execute failed (see above).')
  const out = JSON.parse(result.stdout.toString()) as { results?: Row[] }[]
  return out.flatMap((r) => r.results ?? [])
}

function runLocal(sql: string): Row[] {
  if (!existsSync(LOCAL_DB)) {
    fail(`No local database at ${LOCAL_DB}. Start \`bun dev\` once to create and migrate it.`)
  }
  const db = new Database(LOCAL_DB)
  try {
    return db.query(sql).all() as Row[]
  } catch (error) {
    fail(
      `${String(error)}\nIf a table is missing, start \`bun dev\` once: it applies the migrations.`,
    )
  } finally {
    db.close()
  }
}

export const runSql = (remote: boolean, sql: string) => (remote ? runRemote(sql) : runLocal(sql))
