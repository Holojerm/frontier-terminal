// The terminal's second native rate-limit budget. Core's registry decides which
// binding serves a call site from the numbers alone, so these tests pin the
// three facts that fail silently otherwise: the registered spec matches the
// deployed binding, reads go native, and the permalink budget stays on KV.

import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'

import {
  chooseBackendAmong,
  clearNativeLimitersForTest,
  getNativeLimiters,
  NATIVE_LIMITER,
  registerNativeLimiter,
  type NativeRateLimiter,
} from '../../../server/utils/rate-limit'
import {
  KEYED_EXPORT_LIMIT,
  KEYED_READ_LIMITERS,
  PAYLOAD_LIMIT,
  PERMALINK_LIMIT,
  READ_PATH_LIMITER,
} from '../server/utils/rate-limits'

const fake = (): NativeRateLimiter => ({ limit: async () => ({ success: true }) })

// Whether the binding lets one call past `limit` through. Its windows are
// aligned to the wall clock, and under CI load 1,200 calls can straddle a
// boundary, which resets the count and lets the extra call through (this
// failed main's Workers Build after #171). A run that crosses one is repeated.
async function allowsOneMore(limiter: NativeRateLimiter, limit: number): Promise<boolean> {
  const window = () => Math.floor(Date.now() / 60_000)
  for (let attempt = 1; ; attempt++) {
    const started = window()
    // Unique per run: the binding's counters outlive an individual `it`.
    const key = `drift-check:${crypto.randomUUID()}`
    for (let i = 0; i < limit; i++) {
      expect((await limiter.limit({ key })).success, `request ${i + 1} was refused`).toBe(true)
    }
    const allowed = (await limiter.limit({ key })).success
    if (window() === started || attempt === 3) return allowed
  }
}

afterEach(() => clearNativeLimitersForTest())

describe('READ_PATH_LIMITER', () => {
  it('registers beside core’s limiter and routes a 60/60s read to its own binding', () => {
    registerNativeLimiter(READ_PATH_LIMITER)
    expect(getNativeLimiters()).toEqual([NATIVE_LIMITER, READ_PATH_LIMITER])

    const writer = fake()
    const reader = fake()
    const natives = { [NATIVE_LIMITER.binding]: writer, [READ_PATH_LIMITER.binding]: reader }
    expect(chooseBackendAmong(natives, { limit: 60, windowSeconds: 60 })).toEqual({
      backend: 'native',
      native: reader,
    })
    expect(chooseBackendAmong(natives, { limit: 30, windowSeconds: 60 })).toEqual({
      backend: 'native',
      native: writer,
    })
  })

  it('leaves the permalink budget on KV, whatever is registered', () => {
    registerNativeLimiter(READ_PATH_LIMITER)
    const natives = { [READ_PATH_LIMITER.binding]: fake(), [NATIVE_LIMITER.binding]: fake() }
    expect(chooseBackendAmong(natives, { limit: PERMALINK_LIMIT, windowSeconds: 60 })).toEqual({
      backend: 'kv',
      reason: 'limit-mismatch',
    })
  })

  it('matches the [[ratelimits]] block in wrangler.toml', async () => {
    const limiter = (env as unknown as Record<string, NativeRateLimiter | undefined>)[
      READ_PATH_LIMITER.binding
    ]
    expect(limiter, `no [[ratelimits]] block named ${READ_PATH_LIMITER.binding}`).toBeDefined()
    expect(
      await allowsOneMore(limiter!, READ_PATH_LIMITER.limit),
      `request ${READ_PATH_LIMITER.limit + 1} was allowed — wrangler.toml permits more than the spec`,
    ).toBe(false)
  })
})

describe('KEYED_READ_LIMITERS', () => {
  it('registers each tier beside the read path, and routes its budget to its own binding', () => {
    registerNativeLimiter(READ_PATH_LIMITER)
    for (const spec of Object.values(KEYED_READ_LIMITERS)) registerNativeLimiter(spec)
    const natives = Object.fromEntries(getNativeLimiters().map((s) => [s.binding, fake()]))
    for (const spec of Object.values(KEYED_READ_LIMITERS)) {
      expect(chooseBackendAmong(natives, spec)).toEqual({
        backend: 'native',
        native: natives[spec.binding],
      })
    }
    // A key's export budget is the read path's pair, and its payload budget
    // the research tier's, so both run native.
    expect(chooseBackendAmong(natives, { limit: KEYED_EXPORT_LIMIT, windowSeconds: 60 })).toEqual({
      backend: 'native',
      native: natives[READ_PATH_LIMITER.binding],
    })
    expect(chooseBackendAmong(natives, { limit: PAYLOAD_LIMIT, windowSeconds: 60 })).toEqual({
      backend: 'native',
      native: natives[KEYED_READ_LIMITERS.research.binding],
    })
  })

  it('matches the [[ratelimits]] blocks in wrangler.toml', async () => {
    for (const spec of Object.values(KEYED_READ_LIMITERS)) {
      const limiter = (env as unknown as Record<string, NativeRateLimiter | undefined>)[
        spec.binding
      ]
      expect(limiter, `no [[ratelimits]] block named ${spec.binding}`).toBeDefined()
      expect(
        await allowsOneMore(limiter!, spec.limit),
        `request ${spec.limit + 1} was allowed on ${spec.binding}`,
      ).toBe(false)
    }
  })
})
