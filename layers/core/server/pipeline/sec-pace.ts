import { isSecHost, type FetchOutcome, type SourceFetcher } from './fetch'
import type { FetchSource } from './sources'

// SEC's fair-access policy caps a client at 10 requests a second
// (sec.gov/os/accessing-edgar-data); past it SEC answers 429, and a client
// that keeps going can have its egress blocked. A tick fetches its SEC
// documents one after another through one paced fetcher, so the spacing counts
// every SEC request the tick makes: the edgar tick's feeds and its filed facts
// (layers/terminal/server/exposure/ingest.ts) alike. Other hosts pass straight through.
//
// Spacing is start to start, so a slow response does not buy the next request
// a burst, and each request reserves its slot before it waits, so two callers
// in flight at once still queue. The pacer cannot see another Worker
// invocation: that is why the filed facts stay off the survey instant
// (filedFactsSkip in ingest.ts).

/** 4 requests a second at most: under half of SEC's limit. */
export const SEC_MIN_INTERVAL_MS = 250

export interface PacedFetcher extends SourceFetcher {
  /** The first 429 an SEC host answered through this fetcher, or null. */
  readonly secRateLimited: FetchOutcome | null
}

export interface PaceOptions {
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function paceSec(fetcher: SourceFetcher, options: PaceOptions = {}): PacedFetcher {
  const interval = options.intervalMs ?? SEC_MIN_INTERVAL_MS
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  let next = -Infinity
  let rateLimited: FetchOutcome | null = null

  const paced = async (source: FetchSource): Promise<FetchOutcome> => {
    if (!isSecHost(source.url)) return fetcher(source)
    const at = Math.max(now(), next)
    next = at + interval
    const wait = at - now()
    if (wait > 0) await sleep(wait)
    const outcome = await fetcher(source)
    if (!outcome.ok && outcome.status === 429) rateLimited ??= outcome
    return outcome
  }
  return Object.defineProperty(paced, 'secRateLimited', {
    get: () => rateLimited,
  }) as PacedFetcher
}
