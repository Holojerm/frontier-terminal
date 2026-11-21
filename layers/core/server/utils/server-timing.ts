// Server-Timing for the read path: which stage (the D1 stamp read, a KV payload,
// the HTML edge cache, the render) a slow request spent its time in, so
// `bun run perf` and devtools can attribute a cache miss without a log tail.
//
// Workers freezes the clock between I/O events, so a duration is I/O wait plus
// the CPU before the next I/O: what a reader pays, not a CPU profile.

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
