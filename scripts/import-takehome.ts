// One-off history import — `bun scripts/import-takehome.ts --dry-run | --local | --remote`.
//
// Loads the take-home's exported history (snapshots, changes, alerts) into
// this Worker's D1 and the raw payloads it points at into R2, so the change
// log and the alert feed reach back to 2026-08-25 instead of starting at
// cutover. The row shaping lives in server/pipeline/import/takehome.ts; this
// file is the part that needs a filesystem and a Cloudflare session.
//
// Why wrangler and not a driver: the OAuth session `wrangler login` holds is
// the only credential that never has to appear in a command, and
// `wrangler d1 execute --file` / `wrangler r2 object put` both use it. The
// statements are the same drizzle INSERT ... ON CONFLICT DO NOTHING the
// workerd suite executes directly, rendered to a .sql file.
//
// Safe to re-run: ids are the take-home's, the plan is computed against the
// ids already present, and an R2 object is only written when a GET for its
// key fails. Counts inserted/skipped are printed per table.
//
// Prerequisites:
//   --remote  `wrangler login` (bunx wrangler whoami), migrations applied.
//   --local   `bun run db:migrate` first — wrangler's local D1 lives in
//             .wrangler/state, not the dev server's .data/db (see gotchas).
//   both      a fresh export: `cd <take-home> && make export`.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { drizzle } from 'drizzle-orm/d1'

import * as schema from '../server/db/schema'
import {
  IMPORT_TABLES,
  importStatements,
  parseTakehomeExport,
  planImport,
  renderStatement,
  type ExistingIds,
  type ImportPlan,
  type ImportRows,
  type ImportTable,
  type RawObject,
} from '../server/pipeline/import/takehome'

const ROOT = resolve(import.meta.dir, '..')

// ── Arguments ───────────────────────────────────────────────────────────────

type Target = 'dry-run' | 'local' | 'remote'

interface Args {
  target: Target
  takehome: string
  exportDir: string
  database: string
  bucket: string
}

const USAGE = `usage: bun scripts/import-takehome.ts (--dry-run | --local | --remote) [options]

  --dry-run           parse + validate the export, print what would be written; no wrangler
  --local             write to wrangler's local D1/R2 sandbox (run \`bun run db:migrate\` first)
  --remote            write to production D1/R2 through the wrangler OAuth session
  --takehome <dir>    take-home checkout; raw_path columns resolve under it
                      (default ~/code/frontier-terminal)
  --export <dir>      export directory (default <takehome>/data/export)
  --database <name>   D1 database name (default frontier-terminal-db)
  --bucket <name>     R2 bucket name (default frontier-terminal-blob)
`

function parseArgs(argv: string[]): Args {
  let target: Target | null = null
  let takehome = join(process.env.HOME ?? '', 'code', 'frontier-terminal')
  let exportDir: string | null = null
  let database = 'frontier-terminal-db'
  let bucket = 'frontier-terminal-blob'
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dry-run' || a === '--local' || a === '--remote') {
      if (target) throw new Error('pick exactly one of --dry-run, --local, --remote')
      target = a.slice(2) as Target
    } else if (a === '--takehome') takehome = value(i++, a)
    else if (a === '--export') exportDir = value(i++, a)
    else if (a === '--database') database = value(i++, a)
    else if (a === '--bucket') bucket = value(i++, a)
    else if (a === '--help' || a === '-h') {
      console.info(USAGE)
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  if (!target) throw new Error('pick one of --dry-run, --local, --remote')
  takehome = resolve(takehome)
  return {
    target,
    takehome,
    exportDir: resolve(exportDir ?? join(takehome, 'data/export')),
    database,
    bucket,
  }
}

// ── wrangler ────────────────────────────────────────────────────────────────

function wrangler(args: string[], opts: { quiet?: boolean } = {}) {
  const result = spawnSync('bunx', ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !opts.quiet) {
    throw new Error(
      `wrangler ${args.slice(0, 3).join(' ')} failed:\n${result.stderr}${result.stdout}`,
    )
  }
  return result
}

interface D1Result {
  results: Record<string, unknown>[]
  success: boolean
}

function d1Json(args: Args, sql: string): D1Result[] {
  const out = wrangler([
    'd1',
    'execute',
    args.database,
    `--${args.target}`,
    '--json',
    '--command',
    sql,
  ])
  // --json prints one JSON array; anything before it is bunx/wrangler chatter.
  const start = out.stdout.indexOf('[')
  if (start === -1) throw new Error(`no JSON in wrangler output:\n${out.stdout}${out.stderr}`)
  return JSON.parse(out.stdout.slice(start)) as D1Result[]
}

/** Ids per table, read in one round trip; the plan is computed against them. */
function existingIds(args: Args): ExistingIds {
  const results = d1Json(args, IMPORT_TABLES.map((t) => `SELECT id FROM ${t}`).join('; '))
  const ids = (n: number) => new Set(results[n]!.results.map((r) => String(r.id)))
  return Object.fromEntries(IMPORT_TABLES.map((t, n) => [t, ids(n)])) as unknown as ExistingIds
}

function rowCounts(args: Args): Record<ImportTable, number> {
  const results = d1Json(
    args,
    IMPORT_TABLES.map((t) => `SELECT count(*) AS n FROM ${t}`).join('; '),
  )
  return Object.fromEntries(
    IMPORT_TABLES.map((t, n) => [t, Number(results[n]!.results[0]!.n)]),
  ) as Record<ImportTable, number>
}

function r2Exists(args: Args, key: string): boolean {
  const out = wrangler(
    ['r2', 'object', 'get', `${args.bucket}/${key}`, `--${args.target}`, '--pipe'],
    {
      quiet: true,
    },
  )
  return out.status === 0
}

function r2Put(args: Args, object: RawObject, file: string) {
  wrangler([
    'r2',
    'object',
    'put',
    `${args.bucket}/${object.key}`,
    `--${args.target}`,
    '--file',
    file,
    '--content-type',
    object.content_type,
  ])
}

// ── Raw payloads ────────────────────────────────────────────────────────────

interface RawUpload {
  object: RawObject
  file: string
}

/**
 * Which R2 objects the take-home can still supply. It kept ONE file per
 * source, overwritten on every changed fetch, so a raw_path's bytes belong to
 * exactly the run whose content_hash they hash to. Every other snapshot row
 * keeps the key the Worker would have written — honest about what was fetched
 * and when — but the object behind it is gone.
 */
function availableUploads(args: Args, objects: readonly RawObject[]): RawUpload[] {
  const hashes = new Map<string, string | null>()
  const uploads: RawUpload[] = []
  for (const object of objects) {
    const file = join(args.takehome, object.raw_path)
    if (!hashes.has(file)) {
      hashes.set(
        file,
        existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null,
      )
    }
    if (hashes.get(file) === object.content_hash) uploads.push({ object, file })
  }
  return uploads
}

// ── Main ────────────────────────────────────────────────────────────────────

function readExport(dir: string) {
  const read = (name: string) => {
    const file = join(dir, `${name}.csv`)
    if (!existsSync(file)) throw new Error(`missing ${file} — run \`make export\` in the take-home`)
    return readFileSync(file, 'utf8')
  }
  return { snapshots: read('snapshots'), changes: read('changes'), alerts: read('alerts') }
}

function report(label: string, plan: ImportPlan) {
  console.info(label)
  for (const table of IMPORT_TABLES) {
    const { insert, skipped } = plan[table]
    console.info(
      `  ${table.padEnd(11)} insert ${String(insert.length).padStart(5)}   skip ${String(skipped).padStart(5)}`,
    )
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  console.info(`export:   ${args.exportDir}`)
  console.info(`raw dir:  ${args.takehome}`)

  const rows: ImportRows = parseTakehomeExport(readExport(args.exportDir))
  const uploads = availableUploads(args, rows.rawObjects)
  const window = [rows.snapshots[0]?.fetched_at, rows.snapshots.at(-1)?.fetched_at]
  console.info(
    `parsed:   ${rows.snapshots.length} snapshots, ${rows.changes.length} changes, ` +
      `${rows.alerts.length} alerts (fetched ${window[0]} .. ${window[1]})`,
  )
  const uploadKeys = new Set(uploads.map((u) => u.object.key))
  const covered = rows.snapshots.filter((s) => uploadKeys.has(s.raw_key)).length
  console.info(
    `raw:      ${rows.rawObjects.length} distinct payload runs; bytes on disk for ${uploads.length} ` +
      `(${covered} of ${rows.snapshots.length} snapshot rows resolve to an object)`,
  )
  if (rows.judgeRun)
    console.info(`cursor:   judge_runs.judged_through = ${rows.judgeRun.judged_through}`)

  if (args.target === 'dry-run') {
    const empty = new Set<string>()
    report(
      'would write (against an empty store):',
      planImport(rows, {
        snapshots: empty,
        changes: empty,
        alerts: empty,
        judge_runs: empty,
      }),
    )
    return
  }

  const plan = planImport(rows, existingIds(args))
  report(`plan (${args.target}, ids already present are skipped):`, plan)

  // Objects before rows, as the Worker does: a stored row never points at a
  // payload that was still on its way.
  let put = 0
  for (const { object, file } of uploads) {
    if (r2Exists(args, object.key)) continue
    r2Put(args, object, file)
    put++
  }
  console.info(`r2:       ${put} objects written, ${uploads.length - put} already present`)

  const statements = importStatements(drizzle(null as unknown as D1Database, { schema }), plan)
  if (statements.length === 0) {
    console.info('d1:       nothing to write')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'import-takehome-'))
    const file = join(dir, 'import.sql')
    writeFileSync(file, statements.map(renderStatement).join(';\n') + ';\n')
    console.info(`d1:       ${statements.length} statements -> ${file}`)
    // One file, one call: wrangler splits it into requests of its own size and
    // the import endpoint (--remote) runs it as a single transaction.
    wrangler(['d1', 'execute', args.database, `--${args.target}`, '--yes', '--file', file])
  }

  const counts = rowCounts(args)
  console.info(`store:    ${IMPORT_TABLES.map((t) => `${t}=${counts[t]}`).join('  ')}`)
}

try {
  main()
} catch (err) {
  console.error(`import-takehome: ${err instanceof Error ? err.message : String(err)}`)
  console.error(USAGE)
  process.exit(1)
}
