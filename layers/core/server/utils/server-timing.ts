// Server-Timing for the read path: where a request's wall time went.
//
// A slow first load on this site is a cache miss somewhere — the D1 stamp read,
// a KV payload, the HTML edge cache, the render — and from outside every one of
// them looks the same: a long TTFB. The header names the stage, so `bun run perf`
// and a browser's devtools can attribute a miss without a log tail.
//
// Workers freezes the clock between I/O events, so a duration here is I/O wait
// plus whatever CPU ran before the next I/O. That is the cost a reader pays,
// which is what this is for; it is not a CPU profile.

export interface ServerTiming {
  name: string
  dur: number
  desc?: string
}

/** Collected over one request; `undefined` means the caller is not timing. */
export type ServerTimings = ServerTiming[] | undefined

export async function timed<T>(
  timings: ServerTimings,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!timings) return await run()
  const start = Date.now()
  try {
    return await run()
  } finally {
    timings.push({ name, dur: Date.now() - start })
  }
}

/** The header value: `stamp;dur=12, kv;dur=80;desc="miss"`. */
export function serverTimingHeader(timings: readonly ServerTiming[]): string {
  return timings
    .map((t) => {
      const desc = t.desc ? `;desc="${t.desc.replace(/["\\]/g, '')}"` : ''
      return `${t.name};dur=${Math.round(t.dur)}${desc}`
    })
    .join(', ')
}
