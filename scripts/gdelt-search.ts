// The GDELT side of the track record — `bun run gdelt:search`, run hourly by
// .github/workflows/gdelt-search.yml (the owner's Mac mini, or a hosted runner while it is down).
//
// Reads GDELT's 15-minute GKG files (layers/terminal/server/pipeline/track-record/gkg.ts),
// each once, oldest first:
//
//   1. GET  /api/gdelt/work  the next unread files, the vocabulary (lab, filer
//                            and model-family words), and the User-Agent to
//                            use (the Worker owns all three)
//   2. fetch each file, unzip it, and pick the rows carrying a vocabulary word
//   3. POST /api/gdelt/file  the file's row count and those rows, compacted
//                            to what the matcher reads
//
// and repeats until nothing is unread or --minutes have passed, so a backlog
// (the first run starts at GKG_FROM, 2026-09-01) drains over a few runs. The
// files are static, with no per-IP limit, so no pacing is needed beyond
// reading one at a time. A 404 means GDELT never published that quarter hour
// and is recorded as missing; any other failure to fetch ends the run quietly
// and the next run retries. The job exits non-zero only when our own routes
// fail, so a red run means this site is broken, not GDELT.
//
// No alert is matched here. The Worker keeps the rows, and its cron matches
// each alert against them once the alert's window has closed
// (layers/terminal/server/pipeline/track-record/search.ts › runTrackRecordSearch).
//
//   GDELT_TOKEN=… bun run gdelt:search                    # against production
//   GDELT_TOKEN=… bun run gdelt:search -- --minutes 5     # a shorter run
//   GDELT_TOKEN=… bun run gdelt:search -- --url <origin>  # against another deploy
//
// No `bun install`: Bun built-ins and the layer's own dependency-free modules.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { parseGkgRow, unzipOne } from '../layers/terminal/server/pipeline/track-record/gkg'
import { vocabularyHits } from '../layers/terminal/server/pipeline/track-record/terms'

const ROOT = resolve(import.meta.dir, '..')

/** Per file download. A file is ~2.5 MB; this is generous for a slow link. */
const FETCH_TIMEOUT_MS = 120_000

interface Work {
  user_agent: string
  files: { stamp: string; url: string }[]
  /** Rows carrying one of these are posted as mentions. */
  vocabulary: string[]
}

interface Mention {
  record_id: string
  outlet: string
  url: string
  title: string
  names: string[]
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { url: { type: 'string' }, minutes: { type: 'string' } },
})
const budgetMs = Number(values.minutes ?? 40) * 60_000
const started = Date.now()

const annotate = (level: 'notice' | 'warning' | 'error', message: string) =>
  console.error(process.env.GITHUB_ACTIONS ? `::${level}::${message}` : `${level}: ${message}`)

function appUrl(): string {
  const wrangler = Bun.TOML.parse(readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')) as {
    vars?: Record<string, string>
  }
  const url = wrangler.vars?.NUXT_PUBLIC_APP_URL
  if (!url) throw new Error('wrangler.toml [vars] has no NUXT_PUBLIC_APP_URL; pass --url')
  return url
}

const token = process.env.GDELT_TOKEN?.trim()
if (!token) {
  annotate(
    'warning',
    'GDELT_TOKEN is not set; no GDELT file was read (see .github/workflows/gdelt-search.yml)',
  )
  process.exit(0)
}
const origin = (values.url ?? appUrl()).replace(/\/+$/, '')
const auth = { Authorization: `Bearer ${token}` }

async function ours(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...auth, ...init.headers },
    signal: AbortSignal.timeout(120_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

type Fetched = { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'failed'; why: string }

async function fetchFile(url: string, userAgent: string): Promise<Fetched> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.status === 404) return { kind: 'missing' }
    if (!response.ok) return { kind: 'failed', why: `HTTP ${response.status}` }
    const zip = new Uint8Array(await response.arrayBuffer())
    return { kind: 'ok', text: new TextDecoder().decode(await unzipOne(zip)) }
  } catch (error) {
    return { kind: 'failed', why: String(error).slice(0, 300) }
  }
}

function mentionsOf(text: string, vocabulary: readonly string[]) {
  const lines = text.split('\n').filter((l) => l.trim())
  const mentions: Mention[] = []
  for (const row of lines) {
    const article = parseGkgRow(row)
    if (!article) continue
    const names = vocabularyHits(article, vocabulary)
    if (names.length) {
      const { record_id, outlet, url, title } = article
      mentions.push({ record_id, outlet, url, title, names })
    }
  }
  return { rows: lines.length, mentions }
}

let read = 0
let kept = 0
let missing = 0
let stop: string | null = null
while (!stop && Date.now() - started < budgetMs) {
  const work = (await ours('/api/gdelt/work')) as Work
  if (work.files.length === 0) break
  for (const file of work.files) {
    if (Date.now() - started >= budgetMs) break
    const fetched = await fetchFile(file.url, work.user_agent)
    if (fetched.kind === 'failed') {
      stop = `${file.stamp}: ${fetched.why}`
      break
    }
    const { rows, mentions } =
      fetched.kind === 'ok' ? mentionsOf(fetched.text, work.vocabulary) : { rows: 0, mentions: [] }
    const outcome = (await ours('/api/gdelt/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stamp: file.stamp,
        fetched_at: new Date().toISOString(),
        status: fetched.kind,
        rows,
        mentions,
      }),
    })) as { mentions: number; rejected: number }
    read++
    if (fetched.kind === 'missing') missing++
    kept += outcome.mentions
    if (outcome.rejected) {
      annotate('warning', `${file.stamp}: the site rejected ${outcome.rejected} posted row(s)`)
    }
  }
}
if (stop) annotate('notice', `GDELT file not read (${stop}); the next run retries from there`)
console.info(`read ${read} GKG file(s), ${missing} missing, ${kept} row(s) kept`)
