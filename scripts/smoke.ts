// Post-deploy smoke test — `bun run smoke`, run by .github/workflows/post-deploy-smoke.yml
// on every push to main.
//
// CI proves the code builds; this proves production is serving it. It waits
// for /api/status to report the commit being checked (Workers Builds deploys
// main in ~3 minutes), then checks that the build is healthy and that a few
// key pages and routes answer 200. A deploy that never lands fails it too: on
// 2026-11-04 #169 passed CI, failed Cloudflare's deploy validation (error
// 10021), and production kept serving the previous commit with every check
// green.
//
//   bun run smoke                                  # this checkout's HEAD against production
//   bun run smoke -- --sha <sha> --url <origin> --wait 0
//
// The wait is the only slow part; a failure after it means production is
// broken now, not that it is still deploying.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { readScheduledTasks } from './lib/scheduled-tasks'

const ROOT = resolve(import.meta.dir, '..')

/** The pages and routes a deploy must serve. Each is a 200, or the deploy is broken. */
const PATHS = ['/', '/alerts', '/revenue', '/exposure', '/data', '/api/overview', '/api/coverage']

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    url: { type: 'string' },
    sha: { type: 'string' },
    wait: { type: 'string', default: '1200' },
  },
})

function appUrl(): string {
  const wrangler = Bun.TOML.parse(readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')) as {
    vars?: Record<string, string>
  }
  const url = wrangler.vars?.NUXT_PUBLIC_APP_URL
  if (!url) throw new Error('wrangler.toml [vars] has no NUXT_PUBLIC_APP_URL; pass --url')
  return url
}

const origin = (values.url ?? appUrl()).replace(/\/+$/, '')
const expected =
  values.sha ??
  process.env.GITHUB_SHA ??
  execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
const waitMs = Number(values.wait) * 1000
const POLL_MS = 15_000

const failures: string[] = []
const fail = (message: string) => {
  failures.push(message)
  // A GitHub Actions annotation: shown on the run's summary page, not just in the log.
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `✗ ${message}`)
}

async function get(path: string): Promise<Response> {
  const url = new URL(path, origin)
  // A fresh query string so no cache between here and the Worker answers for it.
  url.searchParams.set('smoke', expected.slice(0, 12))
  return fetch(url, {
    headers: { 'user-agent': 'frontier-terminal-smoke (+github actions)' },
    signal: AbortSignal.timeout(30_000),
  })
}

interface Status {
  status?: string
  database?: string
  build?: { sha?: string | null }
  migrations?: { pending?: string[] }
  crons?: Record<string, string[]>
}

async function readStatus(): Promise<Status | null> {
  try {
    const res = await get('/api/status')
    return res.ok ? ((await res.json()) as Status) : null
  } catch {
    return null
  }
}

// ── 1. production serves this commit ───────────────────────────────────────

const deadline = Date.now() + waitMs
let status = await readStatus()
while (status?.build?.sha !== expected && Date.now() < deadline) {
  console.info(`waiting: ${origin} serves ${status?.build?.sha?.slice(0, 12) ?? 'no status'}`)
  await Bun.sleep(POLL_MS)
  status = await readStatus()
}

if (!status) {
  fail(`${origin}/api/status did not answer 200 with JSON`)
} else if (status.build?.sha !== expected) {
  fail(
    `${origin} still serves ${status.build?.sha ?? 'an unknown build'} after ${waitMs / 60_000} min, ` +
      `not ${expected}: the deploy never landed. Read the build log (cf builds list ` +
      '--external-script-id <id>; .claude/docs/gotchas.md › Workers Builds) and retry it on the full sha.',
  )
} else {
  console.info(`✓ ${origin} serves ${expected}`)

  // ── 2. the build is healthy ───────────────────────────────────────────────
  if (status.status !== 'ok') fail(`/api/status reports status ${status.status}, not ok`)
  if (status.database !== 'connected') fail(`/api/status reports database ${status.database}`)
  const pending = status.migrations?.pending ?? []
  if (pending.length) {
    fail(`production D1 is missing migrations ${pending.join(', ')}: run bun run db:migrate:remote`)
  }

  // ── 3. the crons it runs are the ones this commit declares ────────────────
  const declared = readScheduledTasks(readFileSync(join(ROOT, 'nuxt.config.ts'), 'utf8'))
  const canonical = (map: Record<string, string[]>) =>
    JSON.stringify(
      Object.entries(map)
        .map(([cron, tasks]) => [cron, tasks.toSorted()])
        .toSorted(),
    )
  if (canonical(status.crons ?? {}) !== canonical(declared)) {
    fail(
      `/api/status crons ${JSON.stringify(status.crons)} differ from nuxt.config.ts SCHEDULED_TASKS ` +
        JSON.stringify(declared),
    )
  } else {
    console.info(`✓ crons match nuxt.config.ts (${Object.keys(declared).length} schedules)`)
  }

  // ── 4. key pages and routes answer ────────────────────────────────────────
  for (const path of PATHS) {
    let res: Response | null = null
    // One retry: a colo can still be serving the previous version for a moment.
    for (let attempt = 0; attempt < 2 && !res?.ok; attempt++) {
      if (attempt) await Bun.sleep(5_000)
      res = await get(path).catch(() => null)
    }
    if (res?.ok) console.info(`✓ ${path} ${res.status}`)
    else fail(`${path} answered ${res ? res.status : 'nothing (network error or timeout)'}`)
  }
}

if (failures.length) {
  console.error(`\nsmoke failed: ${failures.length} problem(s) on ${origin} at ${expected}`)
  process.exit(1)
}
console.info(
  `\nsmoke passed: ${origin} serves ${expected.slice(0, 12)} and every key route answers`,
)
