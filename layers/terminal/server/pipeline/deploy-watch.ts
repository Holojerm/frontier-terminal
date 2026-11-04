import { recordOpsEvent } from '#server/utils/ops'
import type { OpsDb } from '#server/utils/ops'
import type { LockStore } from './lock'

// Deploy drift: is production running the commit main points at?
//
// On 2026-11-03 the Workers Build for a merged fix failed before it started
// ("Build failed to initialize and was timed out"). Workers Builds does not
// retry that, nothing in the app noticed, and production served the previous
// commit for seven hours while the sources the fix repaired kept failing.
// So every digest tick asks GitHub for main's head and compares it with the
// sha this build was cut from (runtimeConfig.public.buildSha).
//
// A normal deploy takes ten to fifteen minutes, so one disagreeing tick is a
// deploy in flight. The first tick that sees a given head undeployed records
// when it did; the tick DRIFT_AFTER_MS later spools the event. The marker is
// keyed by the head, so a new merge restarts the clock, and the event repeats
// every DRIFT_RENOTIFY_MS until production catches up.
//
// The head comes from git's smart-HTTP ref advertisement, not the REST API:
// that is unauthenticated, and the REST API's 60-requests-per-hour limit is
// per IP, which Workers shares with every other tenant on the same egress.

const MINUTE_MS = 60 * 1000
/** Under the 30-minute tick, so cron jitter cannot push the alert a tick later. */
export const DRIFT_AFTER_MS = 25 * MINUTE_MS
export const DRIFT_RENOTIFY_MS = 6 * 60 * MINUTE_MS
export const DRIFT_MARKER_TTL_SECONDS = (7 * 24 * 60 * MINUTE_MS) / 1000
export const DRIFT_OPS_PATH = '/api/status'

export const driftMarkerKey = (head: string) => `deploy:drift:${head}`

interface DriftMarker {
  firstSeen: string
  notifiedAt?: string
}

export type DeployDriftVerdict =
  /** Production runs main's head. */
  | { verdict: 'in-sync'; head: string }
  /** The build carries no sha (local or tarball build) or main's head could not be read. */
  | { verdict: 'unknown'; reason: string }
  /** Main is ahead, but for less than DRIFT_AFTER_MS, or it was reported recently. */
  | { verdict: 'pending' | 'already-notified'; head: string; deployed: string; firstSeen: string }
  /** Main has been ahead for DRIFT_AFTER_MS; the ops event was recorded this tick. */
  | { verdict: 'drift'; head: string; deployed: string; firstSeen: string }

/** The sha `refs/heads/<branch>` points at, from a git upload-pack ref advertisement. */
export function parseRefAdvertisement(body: string, branch = 'main'): string | null {
  const ref = `refs/heads/${branch}`
  for (const line of body.split('\n')) {
    const match = /([0-9a-f]{40}) ([^\s\0]+)/.exec(line)
    if (match?.[2] === ref) return match[1]!
  }
  return null
}

/** Main's head commit on GitHub, or null on any failure — a missed tick is not an alert. */
export async function fetchMainHead(
  repoUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(
      `${repoUrl.replace(/\/$/, '')}.git/info/refs?service=git-upload-pack`,
      {
        headers: { 'User-Agent': 'FrontierTerminal-ops/1.0' },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) return null
    return parseRefAdvertisement(await res.text())
  } catch {
    return null
  }
}

export async function checkDeployDrift(
  db: OpsDb,
  marker: LockStore,
  deployed: string,
  head: string | null,
  now: Date = new Date(),
): Promise<DeployDriftVerdict> {
  if (!deployed) return { verdict: 'unknown', reason: 'build carries no sha' }
  if (!head) return { verdict: 'unknown', reason: 'main head unreadable' }
  if (head === deployed) return { verdict: 'in-sync', head }

  const key = driftMarkerKey(head)
  const stored = await marker.get(key)
  const state: DriftMarker = stored
    ? (JSON.parse(stored) as DriftMarker)
    : { firstSeen: now.toISOString() }
  const facts = { head, deployed, firstSeen: state.firstSeen }

  const save = () => marker.put(key, JSON.stringify(state), DRIFT_MARKER_TTL_SECONDS)
  if (!stored) {
    await save()
    return { verdict: 'pending', ...facts }
  }
  if (now.getTime() - Date.parse(state.firstSeen) < DRIFT_AFTER_MS)
    return { verdict: 'pending', ...facts }
  if (state.notifiedAt && now.getTime() - Date.parse(state.notifiedAt) < DRIFT_RENOTIFY_MS) {
    return { verdict: 'already-notified', ...facts }
  }

  await recordOpsEvent(db, {
    kind: 'deploy_drift',
    detail:
      `production runs ${deployed.slice(0, 7)} but main has been at ${head.slice(0, 7)} since at least ` +
      `${state.firstSeen}. The Workers Build for it failed or never ran; retry it with ` +
      '`cf builds create` on the main trigger and the full sha (.claude/docs/gotchas.md › Workers Builds).',
    path: DRIFT_OPS_PATH,
  })
  state.notifiedAt = now.toISOString()
  await save()
  return { verdict: 'drift', ...facts }
}
