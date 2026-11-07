import type { FreshnessCheck } from '../utils/freshness'

// Deploy drift: is production running the commit main points at?
//
// On 2026-11-03 the Workers Build for a merged fix failed before it started
// ("Build failed to initialize and was timed out"). Workers Builds does not
// retry that, nothing in the app noticed, and production served the previous
// commit for seven hours while the sources the fix repaired kept failing.
// So every digest tick asks GitHub for main's head and compares it with the
// sha this build was cut from (runtimeConfig.public.buildSha).
//
// It is a freshness check (utils/freshness.ts): an undeployed head is owed
// work from the first tick that saw it, recorded in KV per head so a new merge
// restarts the clock. A normal deploy takes ten to fifteen minutes, so the
// limit sits just under the 30-minute tick: one disagreeing tick is a deploy
// in flight, the next one spools. The check is keyed by the head too, so the
// six-hour repeat never silences a different merge that also failed to land.
//
// The head comes from git's smart-HTTP ref advertisement, not the REST API:
// that is unauthenticated, and the REST API's 60-requests-per-hour limit is
// per IP, which Workers shares with every other tenant on the same egress.

const MINUTE_MS = 60 * 1000
/** Under the 30-minute tick, so cron jitter cannot push the alert a tick later. */
export const DRIFT_AFTER_MS = 25 * MINUTE_MS
const FIRST_SEEN_TTL_SECONDS = 7 * 24 * 60 * 60

export const driftFirstSeenKey = (head: string) => `deploy:first-seen:${head}`

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

/** `deployed` is this build's sha, empty for a local build; `head` is null when GitHub was unreadable. */
export function deployDriftCheck(deployed: string, head: string | null): FreshnessCheck {
  return {
    key: head ? `deploy:${head}` : 'deploy',
    label: 'The deploy of main',
    kind: 'deploy_drift',
    maxAgeMs: DRIFT_AFTER_MS,
    path: '/api/status',
    async evidence(_db, now, marker) {
      if (!deployed || !head || head === deployed) return { owedSince: null }
      const key = driftFirstSeenKey(head)
      let firstSeen = await marker.get(key)
      if (!firstSeen) {
        firstSeen = now.toISOString()
        await marker.put(key, firstSeen, FIRST_SEEN_TTL_SECONDS)
      }
      return {
        owedSince: firstSeen,
        note:
          `production runs ${deployed.slice(0, 7)}, main is at ${head.slice(0, 7)}. The Workers Build ` +
          'failed or never ran; retry it with `cf builds create` on the main trigger and the full sha ' +
          '(.claude/docs/gotchas.md › Workers Builds)',
      }
    },
  }
}
