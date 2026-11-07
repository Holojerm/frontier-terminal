// External probe: loads production from outside Cloudflare once a minute and
// emails the owner when it stops answering. Runs on the Mac mini as the
// LaunchAgent com.holojerm.probe.frontier-terminal (bun run probe:install).
//
// Why it exists: a request that hangs records no 5xx, so neither the ops spool
// nor Workers Issues sees it reliably, and nothing inside Cloudflare can see a
// DNS, certificate or routing failure at all. On 2026-11-07 one page load in
// eight hung for hours and no alert fired.
//
// It alerts through ~/agent-jobs/notify.sh (Resend), not through the Worker's
// own mail binding, so it still works when the Worker is the thing that's down.
// The mini going down is covered separately by Cloudflare's tunnel-health email.
//
//   bun run scripts/probe.ts            # one run: check, update state, maybe email
//   bun run scripts/probe.ts --dry      # one run, print the result, change nothing

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { INITIAL_STATE, step, type ProbeState } from './lib/probe-state'

const ORIGIN = process.env.PROBE_ORIGIN ?? 'https://frontierterm.com'
const JOBS = join(homedir(), 'agent-jobs')
const STATE_FILE = join(JOBS, 'state', 'probe-frontier-terminal.json')
const NOTIFY = join(JOBS, 'notify.sh')
/** A healthy page answers in under a second; this is a hang, not a slow render. */
const TIMEOUT_MS = 10_000
const ATTEMPTS = 2

/** A cached page, an uncached page and the status route, each with a check of its body. */
const TARGETS: { path: string; ok: (body: string) => boolean }[] = [
  { path: '/', ok: (b) => b.includes('</html>') },
  { path: '/alerts', ok: (b) => b.includes('</html>') },
  { path: '/api/status', ok: (b) => (JSON.parse(b) as { status?: string }).status === 'ok' },
]

interface Failure {
  path: string
  reason: string
}

async function check(path: string, ok: (body: string) => boolean): Promise<Failure | null> {
  const started = Date.now()
  try {
    const res = await fetch(`${ORIGIN}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'frontier-terminal-probe (mac mini)' },
    })
    const body = await res.text()
    if (res.status !== 200) return { path, reason: `HTTP ${res.status}` }
    if (!ok(body)) return { path, reason: 'unexpected body' }
    return null
  } catch (error) {
    const ms = Date.now() - started
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? `no response in ${TIMEOUT_MS / 1000}s`
        : `${String(error)} after ${ms}ms`
    return { path, reason }
  }
}

function readState(): ProbeState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ProbeState
  } catch {
    return INITIAL_STATE
  }
}

function notify(subject: string, body: string): void {
  if (!existsSync(NOTIFY)) {
    console.error(`probe: ${NOTIFY} missing; would have sent "${subject}"`)
    return
  }
  const sent = spawnSync(NOTIFY, [subject, 'owner'], { input: body, encoding: 'utf8' })
  if (sent.status !== 0) console.error(`probe: notify failed: ${sent.stderr}`)
}

const dry = process.argv.includes('--dry')
const checks = TARGETS.flatMap((t) => Array.from({ length: ATTEMPTS }, () => check(t.path, t.ok)))
const failures = (await Promise.all(checks)).filter((f): f is Failure => f !== null)
const now = new Date().toISOString()

if (dry) {
  console.warn(JSON.stringify({ origin: ORIGIN, requests: checks.length, failures }, null, 2))
  process.exit(failures.length ? 1 : 0)
}

const before = readState()
const { state, transition } = step(before, failures.length === 0, now)
mkdirSync(dirname(STATE_FILE), { recursive: true })
writeFileSync(STATE_FILE, JSON.stringify(state))

const detail = failures.map((f) => `  ${f.path}: ${f.reason}`).join('\n')
if (failures.length) console.error(`${now} ${failures.length}/${checks.length} failed\n${detail}`)

if (transition === 'went-down') {
  notify(
    `[Critical] Frontier Terminal is not answering`,
    `${ORIGIN} failed ${failures.length} of ${checks.length} requests from the Mac mini at ${now}, ` +
      `and at least 2 of the last 3 one-minute runs failed.\n\n${detail}\n\n` +
      `Status: ${ORIGIN}/api/status\n` +
      `Logs: https://dash.cloudflare.com/?to=/:account/workers/services/view/frontier-terminal/production/observability\n` +
      `You'll get one more email when it has passed 3 runs in a row.`,
  )
}
if (transition === 'came-up') {
  notify(
    `[Resolved] Frontier Terminal is answering again`,
    `${ORIGIN} has passed 3 runs in a row as of ${now}. It was down from ${before.since ?? 'unknown'}.`,
  )
}
