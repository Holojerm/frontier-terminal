// Keeps the KV payload cache warm, so a reader never pays for a recompute. The
// payload keys carry the build and the poll stamp (terminal-handler.ts ›
// cacheName, terminal-cache.ts › terminalCacheKey), so every deploy and every
// poll that writes a source_runs row orphans them, and the next reader's page
// would recompute a dozen routes from D1 (up to ~700ms for /api/theses). The
// cron renders every enumerable page in-process right after the key moves; one
// marker per (build, stamp) keeps a quiet tick to one D1 and one KV read.
// /prices/<sku> pages are not enumerated, and the HTML edge cache, being per
// data centre, is warmed only in the cron's own.

/** Garbage collection only, like the payload TTL: a new stamp or build makes a new marker. */
export const WARM_MARKER_TTL_SECONDS = 2400

/** Few enough at once that the cron never competes with readers for D1. */
export const WARM_CONCURRENCY = 3

export function warmMarkerKey(build: string, stamp: string | null): string {
  return `cache-warm:${build}:${stamp ?? 'never-polled'}`
}

/**
 * Claims a (build, stamp) warm across isolates. The five-minute tick's
 * cache:warm and each poll's warm can land in different isolates, which
 * runTask's de-duplication cannot see across; unclaimed, they rendered every
 * page at once and D1 refused reads ("too many resources consumed within a 10
 * second window"). Not released: the marker answers success, and after a
 * failure the claim lapses before the next tick. KV's TTL floor is 60s.
 */
export const WARM_LEASE_TTL_SECONDS = 120

export function warmLeaseKey(build: string, stamp: string | null): string {
  return `cache-warm-lease:${build}:${stamp ?? 'never-polled'}`
}

export interface WarmDeps {
  store: CacheStore
  build: string
  stamp: () => Promise<string | null>
  /** Renders one path in-process and resolves to its HTTP status. */
  render: (path: string) => Promise<number>
  /**
   * True while a poll holds the poll lock. Every row it writes moves the stamp,
   * so a warm started mid-poll renders every page for a stamp that is gone by
   * the time it finishes. The poll asks for its own warm once the lock is free.
   */
  pollRunning?: () => Promise<boolean>
}

export type WarmResult =
  | { status: 'already-warm'; stamp: string | null }
  | { status: 'skipped'; reason: 'poll-running' | 'leased'; stamp: string | null }
  | { status: 'warmed'; stamp: string | null; pages: number; failed: string[] }

/** Passes per run when polls keep moving the stamp; the next tick picks up the rest. */
export const WARM_MAX_PASSES = 3

/**
 * Render `paths` once per (build, stamp). The marker is written only when
 * every page answered 200, so a failure retries next tick. A poll can land
 * mid-warm, and a poll's warm request joins the running one (Nitro's runTask),
 * so each pass re-reads the stamp and goes again if it moved.
 */
export async function warmCaches(deps: WarmDeps, paths: readonly string[]): Promise<WarmResult> {
  let result = await warmOnce(deps, paths)
  for (let pass = 1; pass < WARM_MAX_PASSES; pass++) {
    if (result.status !== 'warmed' || (await deps.stamp()) === result.stamp) break
    result = await warmOnce(deps, paths)
  }
  return result
}

async function warmOnce(deps: WarmDeps, paths: readonly string[]): Promise<WarmResult> {
  const stamp = await deps.stamp()
  const marker = warmMarkerKey(deps.build, stamp)
  if (await deps.store.get(marker)) return { status: 'already-warm', stamp }
  if (await deps.pollRunning?.()) return { status: 'skipped', reason: 'poll-running', stamp }
  const lease = warmLeaseKey(deps.build, stamp)
  if (await deps.store.get(lease)) return { status: 'skipped', reason: 'leased', stamp }
  await deps.store.set(lease, true, { ttl: WARM_LEASE_TTL_SECONDS })

  const failed: string[] = []
  const queue = [...paths]
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      try {
        if ((await deps.render(path)) !== 200) failed.push(path)
      } catch {
        failed.push(path)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, worker))

  if (failed.length === 0) {
    await deps.store.set(marker, true, { ttl: WARM_MARKER_TTL_SECONDS })
  }
  return { status: 'warmed', stamp, pages: paths.length, failed }
}

/** Every page a reader can reach without a query or a SKU, deduplicated. */
export function warmPaths(pages: readonly { path: string }[]): string[] {
  return [...new Set(pages.map((p) => p.path))].filter((p) => p.startsWith('/') && !p.includes('?'))
}
