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
    // Unique per run: the binding's counters outlive an individual `it`.
    const key = `drift-check:${crypto.randomUUID()}`
    for (let i = 0; i < READ_PATH_LIMITER.limit; i++) {
      expect((await limiter!.limit({ key })).success, `request ${i + 1} was refused`).toBe(true)
    }
    expect(
      (await limiter!.limit({ key })).success,
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
      const key = `drift-check:${crypto.randomUUID()}`
      for (let i = 0; i < spec.limit; i++) {
        expect((await limiter!.limit({ key })).success, `request ${i + 1} was refused`).toBe(true)
      }
      expect(
        (await limiter!.limit({ key })).success,
        `request ${spec.limit + 1} was allowed on ${spec.binding}`,
      ).toBe(false)
    }
  })
})
