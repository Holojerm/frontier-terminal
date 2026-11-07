// `bun run dev:seed` — fill the local dev DB with production's alerts and the
// change rows they cite, so /alerts, the signal band and the alert permalinks
// have something real to render.
//
// A local poll can't do this: alerts come mostly from the judge routine, which
// runs in the cloud and writes through /api/judge. So this reads the public
// /export routes instead (the trailing 90 days an anonymous reader gets) and
// writes the rows as they are. Only those two tables: every other page fills
// from a local poll, and its entity tables are not exported raw.
//
// Writes straight to .data/db/sqlite.db, the file the dev server reads
// (.claude/docs/gotchas.md › Local D1 lives in two places). Run it with the dev
// server stopped, or restart it after: a running server keeps its own
// connection and won't see the rows. Re-running is safe: rows are keyed by id.

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'

const ORIGIN = process.env.SEED_ORIGIN ?? 'https://frontierterm.com'
const DB_PATH = '.data/db/sqlite.db'
// changes first, so every alert's cited rows are in place before it is.
const TABLES = ['changes', 'alerts'] as const

type Row = Record<string, unknown>

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

if (!existsSync(DB_PATH)) {
  fail(`${DB_PATH} does not exist yet. Run \`bun dev\` once so NuxtHub creates and migrates it.`)
}
const db = new Database(DB_PATH)
const migrated = db
  .query("select 1 from sqlite_master where type = 'table' and name = ?")
  .get(TABLES[0])
if (!migrated) {
  fail(`${DB_PATH} has no ${TABLES[0]} table. Run \`bun dev\` once so NuxtHub migrates it.`)
}

async function fetchTable(table: string): Promise<Row[]> {
  const res = await fetch(`${ORIGIN}/export/${table}.json`, {
    headers: { 'user-agent': 'frontier-terminal-dev-seed' },
  })
  if (!res.ok) fail(`GET ${ORIGIN}/export/${table}.json answered ${res.status}`)
  const rows: unknown = await res.json()
  if (!Array.isArray(rows)) fail(`${table}.json is not a JSON array`)
  return rows as Row[]
}

for (const table of TABLES) {
  const rows = await fetchTable(table)
  const columns = rows[0] ? Object.keys(rows[0]) : []
  if (columns.length === 0) {
    console.warn(`${table}: no rows`)
    continue
  }
  const insert = db.prepare(
    `insert or ignore into ${table} (${columns.map((c) => `"${c}"`).join(', ')}) values (${columns.map(() => '?').join(', ')})`,
  )
  const before = (db.query(`select count(*) as n from ${table}`).get() as { n: number }).n
  db.transaction(() => {
    for (const row of rows) {
      insert.run(
        ...(columns.map((c) => {
          const v = row[c]
          return v === undefined
            ? null
            : typeof v === 'object' && v !== null
              ? JSON.stringify(v)
              : v
        }) as (string | number | null)[]),
      )
    }
  })()
  const after = (db.query(`select count(*) as n from ${table}`).get() as { n: number }).n
  console.warn(`${table}: ${after - before} new of ${rows.length} fetched (${after} now local)`)
}

console.warn('Done. Restart the dev server if it is running.')
