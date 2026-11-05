#!/usr/bin/env bun
// One-off backfill of history from before this site watched the labs, from
// the Internet Archive's captures of each lab's own pages
// (layers/terminal/server/pipeline/archive/): API price lists (eras.ts, rows
// in archived_prices) and job boards (hiring-eras.ts, counts in
// archived_hiring). Never on a cron: the owner runs it, and re-runs are
// idempotent.
//
//   bun run backfill:wayback -- --plan                     list what would be fetched
//   bun run backfill:wayback                               local dev DB (.data/db/sqlite.db)
//   bun run backfill:wayback -- --era openai-api-pricing-2024 --limit 20
//   bun run backfill:wayback -- --axis hiring              job boards only
//   bun run backfill:wayback -- --remote                   production D1 + R2, through wrangler
//
// Flags: --axis pricing|hiring (default both), --provider <id>, --era <id>,
// --cadence-days <n> (default 7: one
// capture per week of each era), --limit <n> captures this run, --redo
// (re-parse captures already recorded, from the saved bytes where we have
// them), --retry-skipped (re-fetch and re-parse only skipped ones).
//
// Resumable: a capture already in archive_captures is not fetched again, so
// an interrupted run picks up where it stopped. Polite: one request at a
// time, WAYBACK_PACE_MS apart, backing off on 429/5xx (wayback.ts).
//
// Bytes are saved under .data/blob/archive/… (the local R2 the dev server
// reads) with a sidecar recording when they were fetched; --remote also puts
// them in the production bucket. A --remote run after a local one re-uses the
// saved bytes and their fetch time rather than asking the Archive again.

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { ARCHIVE_ERAS } from '../layers/terminal/server/pipeline/archive/eras'
import { HIRING_ARCHIVE_ERAS } from '../layers/terminal/server/pipeline/archive/hiring-eras'
import {
  archiveRawKey,
  archiveRows,
  captureId,
  hiringRows,
  skippedCapture,
  type ArchiveAxis,
  type ArchiveCaptureRow,
} from '../layers/terminal/server/pipeline/archive/rows'
import {
  captureUrl,
  cdxUrl,
  finalTimestamp,
  parseCdx,
  sameOriginal,
  sampleCaptures,
  waybackClient,
  type CdxCapture,
} from '../layers/terminal/server/pipeline/archive/wayback'

const ROOT = join(import.meta.dir, '..')
const LOCAL_DB = join(ROOT, '.data/db/sqlite.db')
const LOCAL_BLOB = join(ROOT, '.data/blob')
const D1_NAME = 'frontier-terminal-db'
const R2_BUCKET = 'frontier-terminal-blob'

type Row = Record<string, unknown>

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function flagsOf(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>()
  const rest = argv.filter((a) => a !== '--')
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`)
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next)
      i++
    } else flags.set(arg.slice(2), true)
  }
  return flags
}

const KNOWN = new Set([
  'plan',
  'axis',
  'remote',
  'provider',
  'era',
  'cadence-days',
  'limit',
  'redo',
  'retry-skipped',
])

const lit = (v: unknown) =>
  v === null || v === undefined
    ? 'NULL'
    : typeof v === 'number'
      ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`

// ---- the database ------------------------------------------------------------

interface Target {
  name: string
  query(sql: string): Row[]
  /** Statements applied together: one capture's rows land whole or not at all. */
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
    query: (sql) => {
      try {
        return db.query(sql).all() as Row[]
      } catch (error) {
        fail(
          `${String(error)}\nIf archive_captures is missing, start \`bun dev\` once: it applies the migrations.`,
        )
      }
    },
    apply: (statements) => db.transaction(() => statements.forEach((s) => db.run(s)))(),
    putRaw: () => {}, // the saved bytes already are the local R2 (.data/blob)
  }
}

function remoteTarget(): Target {
  const tmp = join(ROOT, '.data/wayback-sql')
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
      // D1 runs a --file as one batch, so a capture's rows land together.
      const file = join(tmp, 'capture.sql')
      writeFileSync(file, `${statements.join(';\n')};\n`)
      wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', file])
    },
    putRaw: (key, path) =>
      void wrangler(['r2', 'object', 'put', `${R2_BUCKET}/${key}`, '--file', path, '--remote']),
  }
}

function insert(table: string, row: Row, verb = 'INSERT OR REPLACE'): string {
  const cols = Object.keys(row)
  return `${verb} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => lit(row[c])).join(', ')})`
}

/** One era of either axis: its window, and how a capture becomes rows in which table. */
interface Job {
  axis: ArchiveAxis
  era: { id: string; provider: string; url: string; from: string; until: string }
  table: 'archived_prices' | 'archived_hiring'
  rows(capture: CdxCapture, text: string, bytes: number, fetchedAt: string): Built
}

interface Built {
  capture: ArchiveCaptureRow
  rows: Row[]
}

const JOBS: readonly Job[] = [
  ...ARCHIVE_ERAS.map((era): Job => ({
    axis: 'pricing',
    era,
    table: 'archived_prices',
    rows: (c, text, bytes, at) => {
      const out = archiveRows(era, c, text, bytes, at)
      return { capture: out.capture, rows: out.prices }
    },
  })),
  ...HIRING_ARCHIVE_ERAS.map((era): Job => ({
    axis: 'hiring',
    era,
    table: 'archived_hiring',
    rows: (c, text, bytes, at) => {
      const out = hiringRows(era, c, text, bytes, at)
      return { capture: out.capture, rows: out.counts }
    },
  })),
]

function statementsFor(job: Job, built: Built): string[] {
  return [
    `DELETE FROM ${job.table} WHERE capture_id = ${lit(built.capture.id)}`,
    insert('archive_captures', built.capture),
    ...built.rows.map((r) => insert(job.table, r)),
  ]
}

// ---- saved bytes -------------------------------------------------------------

interface Saved {
  text: string
  bytes: number
  fetched_at: string
}

const blobPath = (key: string) => join(LOCAL_BLOB, key)

function readSaved(key: string): Saved | null {
  const path = blobPath(key)
  if (!existsSync(path) || !existsSync(`${path}.json`)) return null
  const meta = JSON.parse(readFileSync(`${path}.json`, 'utf8')) as { fetched_at: string }
  const buf = readFileSync(path)
  return { text: buf.toString('utf8'), bytes: buf.byteLength, fetched_at: meta.fetched_at }
}

function save(key: string, saved: Saved, source_url: string) {
  const path = blobPath(key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, saved.text)
  writeFileSync(
    `${path}.json`,
    JSON.stringify({ fetched_at: saved.fetched_at, source_url, bytes: saved.bytes }, null, 2),
  )
}

// ---- the run -----------------------------------------------------------------

async function main() {
  const flags = flagsOf(process.argv.slice(2))
  for (const name of flags.keys()) if (!KNOWN.has(name)) fail(`Unknown flag --${name}`)
  const cadence = Number(flags.get('cadence-days') ?? 7)
  if (!Number.isInteger(cadence) || cadence < 1 || cadence > 90) {
    fail('--cadence-days must be a whole number from 1 to 90.')
  }
  const limit = flags.has('limit') ? Number(flags.get('limit')) : Infinity
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) {
    fail('--limit must be a positive whole number.')
  }
  const axis = flags.get('axis')
  if (axis !== undefined && axis !== 'pricing' && axis !== 'hiring') {
    fail('--axis must be pricing or hiring.')
  }
  const jobs = JOBS.filter(
    (j) =>
      (axis === undefined || j.axis === axis) &&
      (!flags.has('provider') || j.era.provider === flags.get('provider')) &&
      (!flags.has('era') || j.era.id === flags.get('era')),
  )
  if (jobs.length === 0) fail('No era matches --axis/--provider/--era.')

  const remote = flags.has('remote')
  const plan = flags.has('plan')
  const target = plan ? null : remote ? remoteTarget() : localTarget()
  const log = (line: string) => console.error(line)
  const client = waybackClient({ log })

  const known = new Map<string, string>()
  if (target) {
    for (const r of target.query('SELECT id, status FROM archive_captures')) {
      known.set(String(r.id), String(r.status))
    }
  }

  let done = 0
  const totals = { parsed: 0, skipped: 0, rows: 0 }
  for (const job of jobs) {
    const era = job.era
    const cdx = await client.get(cdxUrl(era.url, era.from, era.until))
    if (!cdx.ok) {
      log(`${era.id}: CDX failed (${cdx.detail}); skipping this era this run.`)
      continue
    }
    const all = parseCdx(cdx.text)
    const sampled = sampleCaptures(all, cadence)
    log(`${era.id}: ${all.length} distinct captures, ${sampled.length} at one per ${cadence}d`)
    if (plan) {
      for (const c of sampled) process.stdout.write(`${era.id}\t${c.timestamp}\t${c.original}\n`)
      continue
    }

    for (const capture of sampled) {
      if (done >= limit) break
      const id = captureId(era, capture.timestamp)
      const status = known.get(id)
      const wanted =
        status === undefined ||
        flags.has('redo') ||
        (flags.has('retry-skipped') && status === 'skipped')
      if (!wanted) continue
      done++

      const result = await captureRows(job, capture, client, remote, target!)
      target!.apply(statementsFor(job, result))
      if (result.capture.status === 'parsed') {
        totals.parsed++
        totals.rows += result.rows.length
        log(
          `  ${id}: ${result.rows.length} rows${result.capture.detail ? ` (${result.capture.detail})` : ''}`,
        )
      } else {
        totals.skipped++
        log(`  ${id}: skipped (${result.capture.detail})`)
      }
    }
  }
  if (!plan) {
    log(
      `Done against ${target!.name}: ${totals.parsed} captures parsed (${totals.rows} rows), ${totals.skipped} skipped.`,
    )
  }
}

async function captureRows(
  job: Job,
  capture: CdxCapture,
  client: ReturnType<typeof waybackClient>,
  remote: boolean,
  target: Target,
): Promise<Built> {
  const era = job.era
  const skip = (at: string, detail: string): Built => ({
    capture: skippedCapture(era, capture, at, detail, null, job.axis),
    rows: [],
  })
  const key = archiveRawKey(era, capture.timestamp)
  const url = captureUrl(capture.timestamp, capture.original)
  let saved = readSaved(key)
  if (!saved) {
    const fetched = await client.get(url)
    const fetched_at = new Date().toISOString()
    if (!fetched.ok) return skip(fetched_at, fetched.detail)
    if (fetched.status !== 200) return skip(fetched_at, `archived HTTP ${fetched.status}`)
    if (
      finalTimestamp(fetched.finalUrl) !== capture.timestamp ||
      !sameOriginal(fetched.finalUrl, capture.original)
    ) {
      return skip(fetched_at, `the Archive answered with a different capture: ${fetched.finalUrl}`)
    }
    saved = { text: fetched.text, bytes: fetched.bytes, fetched_at }
    save(key, saved, url)
  }
  const out = job.rows(capture, saved.text, saved.bytes, saved.fetched_at)
  if (remote) target.putRaw(key, blobPath(key))
  return out
}

await main()
