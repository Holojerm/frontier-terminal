// The GDELT side of the track record — `bun run gdelt:search`, run hourly by
// .github/workflows/gdelt-search.yml.
//
// GDELT limits its DOC API per IP ("one every 5 seconds"), and Cloudflare
// Workers share egress IPs with every other tenant, so from the Worker 85% of
// our queries drew a 429 for traffic that was not ours. This job runs the
// queries from a GitHub runner instead, one at a time at GDELT's pace:
//
//   1. GET  /api/gdelt/pending  the due searches, plus the pace, timeout and
//                               User-Agent to use (the Worker owns those)
//   2. fetch each search's URL from GDELT, spaced, one attempt
//   3. POST /api/gdelt/result   what GDELT answered, bytes and all; the
//                               Worker stores it as its own fetch did
//
// A 429, a timeout or a network error ends the run: GDELT is busy, and the
// next run retries. Those are recorded but never counted toward giving an
// alert up (layers/terminal/server/pipeline/track-record/search.ts). The job
// exits non-zero only when our own routes fail, so a red run means this
// site is broken, not GDELT.
//
//   GDELT_TOKEN=… bun run gdelt:search                    # against production
//   GDELT_TOKEN=… bun run gdelt:search -- --url <origin>  # against another deploy
//
// Bun built-ins only, so the workflow needs no `bun install`.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = resolve(import.meta.dir, '..')

interface Pending {
  spacing_ms: number
  timeout_ms: number
  user_agent: string
  searches: { alert_id: string; query: string; url: string }[]
}

type Answer =
  | { kind: 'http'; status: number; text: string }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string }

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' } } })

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
    'GDELT_TOKEN is not set; no GDELT search ran (see .github/workflows/gdelt-search.yml)',
  )
  process.exit(0)
}
const origin = (values.url ?? appUrl()).replace(/\/+$/, '')
const auth = { Authorization: `Bearer ${token}` }

async function ours(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...auth, ...init.headers },
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

async function askGdelt(url: string, pending: Pending): Promise<Answer> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': pending.user_agent, Accept: 'application/json' },
      signal: AbortSignal.timeout(pending.timeout_ms),
    })
    return { kind: 'http', status: response.status, text: await response.text() }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return { kind: 'timeout' }
    return { kind: 'error', message: String(error).slice(0, 500) }
  }
}

const pending = (await ours('/api/gdelt/pending')) as Pending
console.info(`${pending.searches.length} GDELT search(es) due`)

let searched = 0
for (const [i, search] of pending.searches.entries()) {
  if (i > 0) await Bun.sleep(pending.spacing_ms)
  const answer = await askGdelt(search.url, pending)
  const outcome = (await ours('/api/gdelt/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      alert_id: search.alert_id,
      url: search.url,
      fetched_at: new Date().toISOString(),
      answer,
    }),
  })) as { status: 'ok' | 'failed'; transient: boolean; candidates: number }
  searched++
  const label = answer.kind === 'http' ? `HTTP ${answer.status}` : answer.kind
  console.info(
    `${search.alert_id.slice(0, 12)} ${label}: ${outcome.status}` +
      (outcome.status === 'ok' ? `, ${outcome.candidates} article(s)` : ''),
  )
  if (outcome.transient) {
    annotate('notice', `GDELT is busy (${label}); the rest wait for the next run`)
    break
  }
}
console.info(`searched ${searched} of ${pending.searches.length}`)
