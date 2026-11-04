// Keeps the KV payload cache warm, so a reader never pays for a recompute.
//
// The payload keys carry the build and the poll stamp (terminal-handler.ts ›
// cacheName, terminal-cache.ts › terminalCacheKey), so every deploy and every
// poll that writes a source_runs row orphans all of them. On a site this
// quiet, the next reader after that is nearly always a stranger: their page
// fans out to a dozen API routes, each recomputing from D1 (up to ~700ms for
// /api/theses), measured with Server-Timing on 2026-11-04.
//
// The cron renders every enumerable page in-process right after the key
// moves, which runs the exact API calls (and query variants) the pages make,
// so the reader that follows reads KV. One marker per (build, stamp) keeps a
// quiet tick to one D1 read and one KV read.
//
// What this cannot warm: the HTML edge cache is per data centre, so the
// renders here fill only the cron's own; /prices/<sku> pages are not
// enumerated (hundreds of them, each its own payload) and stay on demand.

import type { CacheStore } from './terminal-cache'

/** Garbage collection only, like the payload TTL: a new stamp or build makes a new marker. */
export const WARM_MARKER_TTL_SECONDS = 2400

/** Few enough at once that the cron never competes with readers for D1. */
export const WARM_CONCURRENCY = 3

export function warmMarkerKey(build: string, stamp: string | null): string {
  return `cache-warm:${build}:${stamp ?? 'never-polled'}`
}

export interface WarmDeps {
  store: CacheStore
  build: string
  stamp: () => Promise<string | null>
  /** Renders one path in-process and resolves to its HTTP status. */
  render: (path: string) => Promise<number>
}

export type WarmResult =
  | { status: 'already-warm'; stamp: string | null }
  | { status: 'warmed'; stamp: string | null; pages: number; failed: string[] }

/** Passes per run when polls keep moving the stamp; the next tick picks up the rest. */
export const WARM_MAX_PASSES = 3

/**
 * Render `paths` once per (build, stamp). The marker is written only when every
 * page answered 200, so a transient failure is retried on the next tick rather
 * than leaving a cold key until the next poll.
 *
 * A poll can land mid-warm (the five-minute tick runs the tripwire alongside
 * this), and a poll task that asks for a warm while one is running is handed
 * the running one (Nitro's runTask). So each pass re-reads the stamp at the
 * end and goes again if it moved.
 */
export async function warmCaches(deps: WarmDeps, paths: readonly string[]): Promise<WarmResult> {
  let result = await warmOnce(deps, paths)
  for (let pass = 1; pass < WARM_MAX_PASSES; pass++) {
    if ((await deps.stamp()) === result.stamp) break
    result = await warmOnce(deps, paths)
  }
  return result
}

async function warmOnce(deps: WarmDeps, paths: readonly string[]): Promise<WarmResult> {
  const stamp = await deps.stamp()
  const marker = warmMarkerKey(deps.build, stamp)
  if (await deps.store.get(marker)) return { status: 'already-warm', stamp }

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
