// The terminal's second native rate-limit budget. Core's registry decides which
// binding serves a call site from the numbers alone, so these tests pin the
// three facts that fail silently otherwise: the registered spec matches the
// deployed binding, reads go native, and the permalink budget stays on KV.

import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'

import WRANGLER_TOML from '../../../wrangler.toml?raw'

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

// Reads every [[ratelimits]] block out of wrangler.toml. miniflare builds the bindings from this
// same file, so the text is the deployed number. Exhausting the binding instead was both slow
// (1,200 sequential calls blew the 5 s test timeout on a Workers Build) and wall-clock
// dependent: its windows align to the clock, so a run that straddled a boundary let the extra
// call through.
function declaredLimits(): Map<string, { limit: number; period: number }> {
  const declared = new Map<string, { limit: number; period: number }>()
  for (const [, body] of WRANGLER_TOML.matchAll(/^\[\[ratelimits\]\]\n((?:(?!\[).*\n?)*)/gm)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(body!)?.[1]
    if (name) {
      declared.set(name, {
        limit: Number(/limit\s*=\s*(\d+)/.exec(body!)?.[1]),
        period: Number(/period\s*=\s*(\d+)/.exec(body!)?.[1]),
      })
    }
  }
  return declared
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

  it('matches the [[ratelimits]] block in wrangler.toml', () => {
    const binding = (env as unknown as Record<string, NativeRateLimiter | undefined>)[
      READ_PATH_LIMITER.binding
    ]
    expect(binding, `no [[ratelimits]] block named ${READ_PATH_LIMITER.binding}`).toBeDefined()
    expect(declaredLimits().get(READ_PATH_LIMITER.binding)).toEqual({
      limit: READ_PATH_LIMITER.limit,
      period: READ_PATH_LIMITER.windowSeconds,
    })
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

  it('matches the [[ratelimits]] blocks in wrangler.toml', () => {
    const declared = declaredLimits()
    for (const spec of Object.values(KEYED_READ_LIMITERS)) {
      const binding = (env as unknown as Record<string, NativeRateLimiter | undefined>)[
        spec.binding
      ]
      expect(binding, `no [[ratelimits]] block named ${spec.binding}`).toBeDefined()
      expect(declared.get(spec.binding), `wrangler.toml disagrees on ${spec.binding}`).toEqual({
        limit: spec.limit,
        period: spec.windowSeconds,
      })
    }
  })
})
