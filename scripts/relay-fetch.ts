// The relay: `bun run relay:fetch`, run every 30 minutes on the owner's Mac mini by a
// launchd job outside this repo (~/agent-jobs/relay-fetch.sh). Some sources' CDNs refuse
// Cloudflare Workers' egress but answer the mini (layers/core/server/pipeline/relay.ts):
//
//   1. GET  /api/relay/work  the URLs on those hosts the pipeline asked for lately,
//                            each with the User-Agent to send (the Worker owns both)
//   2. fetch each, one at a time
//   3. POST /api/relay/file  the bytes and the status the source answered
//
// Any answer is posted, a 403 or 429 included, so the Worker records what the source
// said. A URL that could not be fetched at all is left for the next run; once the
// Worker's copy is older than RELAY_MAX_AGE_MS, the source shows as failing on fleet.
// The job exits non-zero only when our own routes fail.
//
//   GDELT_TOKEN=… bun run relay:fetch                    # against production
//   GDELT_TOKEN=… bun run relay:fetch -- --url <origin>  # against another deploy
//
// No `bun install`: Bun built-ins only.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = resolve(import.meta.dir, '..')
const FETCH_TIMEOUT_MS = 120_000
/** Matches RELAY_MAX_BYTES; the Worker refuses anything larger. */
const MAX_BYTES = 20 * 1024 * 1024

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' } } })

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
  console.error('warning: GDELT_TOKEN is not set; nothing was relayed')
  process.exit(0)
}
const origin = (values.url ?? appUrl()).replace(/\/+$/, '')
const auth = { Authorization: `Bearer ${token}` }

const work = await fetch(`${origin}/api/relay/work`, {
  headers: auth,
  signal: AbortSignal.timeout(60_000),
})
if (!work.ok) throw new Error(`/api/relay/work: HTTP ${work.status}`)
const { urls } = (await work.json()) as { urls: { url: string; user_agent: string | null }[] }

let posted = 0
for (const { url, user_agent } of urls) {
  let status: number
  let body: Uint8Array
  let contentType: string
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': user_agent ?? 'FrontierTerminal', Accept: '*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    status = response.status
    body = new Uint8Array(await response.arrayBuffer())
    contentType = response.headers.get('content-type') ?? 'application/octet-stream'
  } catch (error) {
    console.error(`skip ${url}: ${String(error).slice(0, 200)}`)
    continue
  }
  if (body.byteLength > MAX_BYTES) {
    console.error(`skip ${url}: ${body.byteLength} bytes is over ${MAX_BYTES}`)
    continue
  }
  const query = new URLSearchParams({
    url,
    status: String(status),
    fetched_at: new Date().toISOString(),
  })
  const post = await fetch(`${origin}/api/relay/file?${query}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!post.ok) throw new Error(`/api/relay/file ${url}: HTTP ${post.status} ${await post.text()}`)
  posted++
  console.error(`${status} ${url} (${body.byteLength} bytes)`)
}
console.error(`relayed ${posted} of ${urls.length}`)
