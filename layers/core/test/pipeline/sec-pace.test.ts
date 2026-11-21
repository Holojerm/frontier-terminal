import { describe, expect, it } from 'vitest'

import type { FetchOutcome, SourceFetcher } from '../../server/pipeline/fetch'
import { SEC_MIN_INTERVAL_MS, paceSec } from '../../server/pipeline/sec-pace'
import type { FetchSource } from '../../server/pipeline/sources'

// The SEC pacer: request starts to an SEC host at least SEC_MIN_INTERVAL_MS
// apart, other hosts untouched, the first 429 remembered for the tick.

const sec = (n: number): FetchSource => ({
  source_id: `sec-${n}`,
  url: `https://data.sec.gov/submissions/CIK000000000${n}.json`,
  ext: 'json',
})
const other: FetchSource = { source_id: 'x', url: 'https://docs.x.ai/models.md', ext: 'md' }
const ok: FetchOutcome = { ok: true, status: 200, text: '{}', bytes: 2 }
const limited: FetchOutcome = { ok: false, status: 429, detail: 'HTTP 429 (Retry-After 600s)' }

function clock(responseMs: (s: FetchSource) => number, answer: (s: FetchSource) => FetchOutcome) {
  let t = 1_000_000
  const starts: { id: string; at: number }[] = []
  const sleeps: number[] = []
  const inner: SourceFetcher = async (s) => {
    starts.push({ id: s.source_id, at: t })
    t += responseMs(s)
    return answer(s)
  }
  const fetcher = paceSec(inner, {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms)
      t += ms
    },
  })
  return { fetcher, starts, sleeps }
}

describe('paceSec', () => {
  it('spaces SEC request starts, and leaves other hosts alone', async () => {
    const c = clock(
      () => 40,
      () => ok,
    )
    await c.fetcher(sec(1))
    await c.fetcher(other)
    await c.fetcher(sec(2))
    await c.fetcher(sec(3))
    const secStarts = c.starts.filter((s) => s.id.startsWith('sec-')).map((s) => s.at)
    expect(secStarts[1]! - secStarts[0]!).toBe(SEC_MIN_INTERVAL_MS)
    expect(secStarts[2]! - secStarts[1]!).toBe(SEC_MIN_INTERVAL_MS)
    // The non-SEC fetch went out at once, between the first two SEC ones.
    expect(c.starts[1]).toEqual({ id: 'x', at: c.starts[0]!.at + 40 })
    expect(SEC_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(1000 / 5)
  })

  it('does not wait after a response slower than the interval', async () => {
    const c = clock(
      () => 400,
      () => ok,
    )
    await c.fetcher(sec(1))
    await c.fetcher(sec(2))
    expect(c.sleeps).toEqual([])
  })

  it('queues callers in flight at once rather than letting them burst', async () => {
    // Each caller reserves its slot before it sleeps: the three waits are
    // measured from the same instant.
    const sleeps: number[] = []
    const fetcher = paceSec(async () => ok, {
      now: () => 0,
      sleep: async (ms) => void sleeps.push(ms),
    })
    await Promise.all([fetcher(sec(1)), fetcher(sec(2)), fetcher(sec(3))])
    expect(sleeps).toEqual([SEC_MIN_INTERVAL_MS, 2 * SEC_MIN_INTERVAL_MS])
  })

  it('remembers the first SEC 429 of the tick, and only SEC’s', async () => {
    const c = clock(
      () => 10,
      (s) => (s.source_id === 'sec-2' || s.source_id === 'x' ? limited : ok),
    )
    await c.fetcher(other)
    expect(c.fetcher.secRateLimited).toBeNull()
    await c.fetcher(sec(1))
    await c.fetcher(sec(2))
    await c.fetcher(sec(3))
    expect(c.fetcher.secRateLimited).toEqual(limited)
  })
})
