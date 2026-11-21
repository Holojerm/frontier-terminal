// SEC's fair-access policy caps a client at 10 requests a second
// (sec.gov/os/accessing-edgar-data); past it SEC answers 429 and may block the
// egress. Every SEC request in a tick goes through this one paced fetcher, start
// to start, each reserving its slot before it waits so concurrent callers queue.
// Other hosts pass through. It cannot see another invocation, so the filed facts
// stay off the survey instant (filedFactsSkip in ingest.ts).

/** 4 requests a second at most: under half of SEC's limit. */
export const SEC_MIN_INTERVAL_MS = 250

interface PacedFetcher extends SourceFetcher {
  /** The first 429 an SEC host answered through this fetcher, or null. */
  readonly secRateLimited: FetchOutcome | null
}

interface PaceOptions {
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
