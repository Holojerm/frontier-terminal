#!/usr/bin/env bun
// One-off backfill of OpenRouter's daily rankings from 2025-01-01 to the day
// before the oldest one stored (layers/adoption/server/pipeline/rankings-history.ts).
// Never on a cron: the owner runs it, and a re-run asks only for days still
// missing.
//
//   bun run backfill:rankings -- --plan                 list the windows, fetch nothing
//   op read "op://…" | bun run backfill:rankings        local dev DB (.data/db/sqlite.db)
//   op read "op://…" | bun run backfill:rankings -- --remote   production D1 + R2, through wrangler
//
// The key is read from stdin, or NUXT_OPENROUTER_API_KEY when stdin is a
// terminal. It is sent only to openrouter.ai and never printed.
//
// Rows are written as the first observation of a source is (refresh.ts ›
// baseline): entities and their snapshot, with no change rows and no
// source_runs row, so nothing is announced as new and the live source's
// latest run is untouched. A stored row is never overwritten. The bytes go
// to .data/blob/<raw_key>, and with --remote to the production bucket too.

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Window } from '../layers/adoption/server/pipeline/rankings-history'

const ROOT = join(import.meta.dir, '..')

// The parser reaches fixtures/manifest.json through Nuxt's `~~` alias, which
// Bun does not know; registered before the pipeline modules load.
Bun.plugin({
  name: 'nuxt-root-alias',
  setup(build) {
    build.onResolve({ filter: /^~~\// }, (args) => ({ path: join(ROOT, args.path.slice(3)) }))
  },
})
const { backfillWindows, RANKINGS_SOURCE_ID, windowRows, windowUrl } =
  await import('../layers/adoption/server/pipeline/rankings-history')
const LOCAL_DB = join(ROOT, '.data/db/sqlite.db')
const LOCAL_BLOB = join(ROOT, '.data/blob')
const D1_NAME = 'frontier-terminal-db'
const R2_BUCKET = 'frontier-terminal-blob'
const USER_AGENT =
  'FrontierTerminal/1.0 (+https://frontierterm.com; one-off rankings history backfill)'
/** 30 requests a minute per key; two windows cover the whole dataset. */
const PACE_MS = 3_000
/** Rows per INSERT: ~700 bytes each keeps a statement under D1's 100 KB. */
const ROWS_PER_INSERT = 50

type Row = Record<string, unknown>

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const lit = (v: unknown) =>
  v === null || v === undefined
    ? 'NULL'
    : typeof v === 'number'
      ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`

function inserts(table: string, rows: readonly Row[], tail: string): string[] {
  if (rows.length === 0) return []
  const cols = Object.keys(rows[0]!)
  const out: string[] = []
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const values = rows
      .slice(i, i + ROWS_PER_INSERT)
      .map((r) => `(${cols.map((c) => lit(r[c])).join(', ')})`)
    out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values.join(', ')} ${tail}`)
  }
  return out
}

interface Target {
  name: string
  query(sql: string): Row[]
  /** One window's statements, applied together. */
  apply(statements: string[]): void
  putRaw(key: string, path: string): void
}

function localTarget(): Target {
  if (!existsSync(LOCAL_DB)) {
    fail(`No local database at ${LOCAL_DB}. Start \`bun dev\` once to create and migrate it.`)
  }
  const db = new Database(LOCAL_DB)
  return {
    name: 'the local database',
    query: (sql) => db.query(sql).all() as Row[],
    apply: (statements) => db.transaction(() => statements.forEach((s) => db.run(s)))(),
    putRaw: () => {}, // .data/blob already is the local R2
  }
}

function remoteTarget(): Target {
  const tmp = join(ROOT, '.data/rankings-sql')
  mkdirSync(tmp, { recursive: true })
  const wrangler = (args: string[]) => {
    const result = Bun.spawnSync(['bunx', 'wrangler', ...args], { cwd: ROOT, stderr: 'inherit' })
    if (result.exitCode !== 0) fail(`wrangler ${args.slice(0, 3).join(' ')} failed (see above).`)
    return result.stdout.toString()
  }
  return {
    name: 'production D1',
    query: (sql) => {
      const out = JSON.parse(
        wrangler(['d1', 'execute', D1_NAME, '--remote', '--json', '--command', sql]),
      ) as { results?: Row[] }[]
      return out.flatMap((r) => r.results ?? [])
    },
    apply: (statements) => {
      const file = join(tmp, 'window.sql')
      writeFileSync(file, `${statements.join(';\n')};\n`)
      wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', file, '--yes'])
    },
    putRaw: (key, path) =>
      void wrangler(['r2', 'object', 'put', `${R2_BUCKET}/${key}`, '--file', path, '--remote']),
  }
}

async function readKey(): Promise<string> {
  const piped = process.stdin.isTTY ? '' : (await Bun.stdin.text()).trim()
  const key = piped || process.env.NUXT_OPENROUTER_API_KEY?.trim() || ''
  if (!key)
    fail('No OpenRouter key: pipe it in (op read "op://…" | …) or set NUXT_OPENROUTER_API_KEY.')
  return key
}

async function fetchWindow(window: Window, key: string): Promise<string> {
  const res = await fetch(windowUrl(window), {
    headers: {
      Authorization: `Bearer ${key}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  })
  const text = await res.text()
  if (!res.ok) fail(`${windowUrl(window)}: HTTP ${res.status} ${text.slice(0, 200)}`)
  return text
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--')
  const unknown = args.filter((a) => a !== '--plan' && a !== '--remote')
  if (unknown.length) fail(`Unknown argument: ${unknown.join(' ')}`)
  const target = args.includes('--remote') ? remoteTarget() : localTarget()

  const [row] = target.query(
    `SELECT min(json_extract(payload, '$.date')) AS oldest FROM entities WHERE source_id = ${lit(RANKINGS_SOURCE_ID)} AND entity_type = 'ranking'`,
  )
  const oldest = typeof row?.oldest === 'string' ? row.oldest : null
  if (!oldest) fail(`No rankings stored in ${target.name}: let the live source poll once first.`)

  const windows = backfillWindows(oldest)
  console.warn(`${target.name}: oldest stored day ${oldest}; ${windows.length} window(s) to fetch`)
  for (const w of windows) console.warn(`  ${w.start} .. ${w.end}`)
  if (windows.length === 0 || args.includes('--plan')) return

  const key = await readKey()
  for (const [i, window] of windows.entries()) {
    if (i > 0) await Bun.sleep(PACE_MS)
    const fetched_at = new Date().toISOString()
    const text = await fetchWindow(window, key)
    let built
    try {
      built = windowRows(window, text, fetched_at)
    } catch (error) {
      fail(`${window.start}..${window.end}: ${String(error)}`)
    }

    // Bytes first, so no stored row cites a payload that is not there.
    const path = join(LOCAL_BLOB, built.snapshot.raw_key)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    target.putRaw(built.snapshot.raw_key, path)

    target.apply([
      ...inserts('snapshots', [built.snapshot], 'ON CONFLICT DO NOTHING'),
      ...inserts('entities', built.entities, 'ON CONFLICT (source_id, entity_key) DO NOTHING'),
    ])
    const days = new Set(built.entities.map((e) => JSON.parse(e.payload).date)).size
    console.warn(
      `  ${window.start}..${window.end}: ${built.entities.length} rows over ${days} days, as_of ${built.as_of}`,
    )
  }
}

await main()
