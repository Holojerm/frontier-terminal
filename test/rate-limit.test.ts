// The rate limiter: its window arithmetic, and which of its two backends runs.
//
// consumeRateLimit takes its store and its clock as arguments precisely so this
// suite can test the boundary behaviour that matters — a window rolling over
// mid-attack — without sleeping through real seconds. consumeRateLimitWithFallback
// takes the native binding the same way, for the same reason.

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  chooseBackend,
  consumeRateLimit,
  consumeRateLimitWithFallback,
  NATIVE_LIMITERS,
  type NativeRateLimiter,
  type RateLimitStore,
} from '../server/utils/rate-limit'

/** Map-backed stand-in for unstorage. TTL is recorded, not enforced — the keys
 *  are window-scoped, so expiry is housekeeping rather than correctness. */
function makeStore(): RateLimitStore & { size: () => number } {
  const data = new Map<string, unknown>()
  return {
    get: async (key) => data.get(key),
    set: async (key, value) => data.set(key, value),
    size: () => data.size,
  }
}

const OPTS = { key: 'login:1.2.3.4', limit: 3, windowSeconds: 60 }

/** The numbers of the first declared block — a pair that must resolve natively. */
const DECLARED = NATIVE_LIMITERS[0]!
const MATCHED = { limit: DECLARED.limit, windowSeconds: DECLARED.windowSeconds }

/** A (limit, windowSeconds) pair no block declares, for the mismatch cases. */
const UNDECLARED_LIMIT = Math.max(...NATIVE_LIMITERS.map((l) => l.limit)) + 1

/** Stand-in for `env.RATE_LIMITER`, recording what it was asked. */
function makeNative(verdicts: boolean[]): NativeRateLimiter & { keys: string[] } {
  const keys: string[] = []
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key)
      return { success: verdicts[keys.length - 1] ?? true }
    },
  }
}

const THROWING_NATIVE: NativeRateLimiter = {
  limit: async () => {
    throw new Error('binding exploded')
  },
}

describe('consumeRateLimit', () => {
  it('allows up to the limit and then blocks', async () => {
    const store = makeStore()
    const now = 1_000_000_000_000

    const first = await consumeRateLimit(store, OPTS, now)
    expect(first).toMatchObject({ allowed: true, remaining: 2 })

    await consumeRateLimit(store, OPTS, now)
    const third = await consumeRateLimit(store, OPTS, now)
    expect(third).toMatchObject({ allowed: true, remaining: 0 })

    const fourth = await consumeRateLimit(store, OPTS, now)
    expect(fourth.allowed).toBe(false)
    expect(fourth.remaining).toBe(0)
  })

  it('does not consume budget once blocked', async () => {
    // A blocked request must not write, or a client that keeps hammering keeps
    // pushing the counter up and never recovers within the window.
    const store = makeStore()
    const now = 1_000_000_000_000
    for (let i = 0; i < 5; i++) await consumeRateLimit(store, OPTS, now)

    expect(store.size()).toBe(1)
    expect(await store.get('ratelimit:login:1.2.3.4:16666666')).toBe(3)
  })

  it('resets when the window rolls over', async () => {
    const store = makeStore()
    const now = 1_000_000_000_000

    for (let i = 0; i < 3; i++) await consumeRateLimit(store, OPTS, now)
    expect((await consumeRateLimit(store, OPTS, now)).allowed).toBe(false)

    const nextWindow = now + 60_000
    expect((await consumeRateLimit(store, OPTS, nextWindow)).allowed).toBe(true)
  })

  it('reports seconds until reset, for Retry-After', async () => {
    const store = makeStore()
    // Windows are aligned to absolute epoch time, not to first contact:
    // 1_000_000_020s is a multiple of 60, so this is 15 seconds in → 45 left.
    const now = 1_000_000_035_000
    const result = await consumeRateLimit(store, OPTS, now)
    expect(result.resetSeconds).toBe(45)
  })

  it('keeps separate callers in separate buckets', async () => {
    const store = makeStore()
    const now = 1_000_000_000_000

    for (let i = 0; i < 3; i++) {
      await consumeRateLimit(store, { ...OPTS, key: 'login:1.1.1.1' }, now)
    }

    expect((await consumeRateLimit(store, { ...OPTS, key: 'login:1.1.1.1' }, now)).allowed).toBe(
      false,
    )
    expect((await consumeRateLimit(store, { ...OPTS, key: 'login:2.2.2.2' }, now)).allowed).toBe(
      true,
    )
  })

  it('coerces a stringified count rather than producing NaN', async () => {
    // KV can hand back a string for a value written by another runtime; NaN >= 3
    // is false, which would silently disable the limit.
    const store = makeStore()
    const now = 1_000_000_000_000
    await store.set('ratelimit:login:1.2.3.4:16666666', '3')

    expect((await consumeRateLimit(store, OPTS, now)).allowed).toBe(false)
  })
})

describe('chooseBackend', () => {
  /** Resolves any name to the same fake — the name choice is what's under test. */
  const anyBinding = (native: NativeRateLimiter) => () => native

  it('picks the native binding when both numbers match a declared block', () => {
    const native = makeNative([])
    expect(chooseBackend(anyBinding(native), MATCHED)).toEqual({ backend: 'native', native })
  })

  it('asks for the binding belonging to the budget, not just any binding', () => {
    // The whole reason there are two blocks: a handler's numbers select which
    // one runs. Pairing a 60/60s handler with the 30/60s binding would enforce
    // the wrong budget silently, so the name is derived, never passed in.
    for (const declared of NATIVE_LIMITERS) {
      const asked: string[] = []
      chooseBackend(
        (name) => {
          asked.push(name)
          return makeNative([])
        },
        { limit: declared.limit, windowSeconds: declared.windowSeconds },
      )
      expect(asked).toEqual([declared.binding])
    }
  })

  it('declares no two blocks with the same budget', () => {
    // chooseBackend takes the first match, so a duplicate pair would make one
    // binding permanently unreachable without any error.
    const pairs = NATIVE_LIMITERS.map((l) => `${l.limit}/${l.windowSeconds}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('falls back to KV when there is no binding', () => {
    // The `nuxt build` output on a non-Cloudflare preset, a trimmed
    // wrangler.toml, a wrangler too old to know the binding. None of them throw.
    expect(chooseBackend(() => undefined, MATCHED)).toEqual({
      backend: 'kv',
      reason: 'binding-absent',
    })
  })

  it('falls back to KV for a window no block was deployed for', () => {
    // A call site that wants 10 per 300s: the platform only permits periods of
    // 10 or 60, so no binding could serve this one.
    expect(chooseBackend(anyBinding(makeNative([])), { limit: 10, windowSeconds: 300 })).toEqual({
      backend: 'kv',
      reason: 'window-mismatch',
    })
  })

  it('falls back to KV when the limit differs, rather than enforcing the wrong one', () => {
    // A call site asks for a 60s budget no block declares — PERMALINK_LIMIT's
    // 500/60s is the real one. The bindings cannot be told a different number at
    // call time, so delegating would enforce theirs while the response header
    // promised this one. This is the case the exact-match rule exists for.
    expect(
      chooseBackend(anyBinding(makeNative([])), { limit: UNDECLARED_LIMIT, windowSeconds: 60 }),
    ).toEqual({
      backend: 'kv',
      reason: 'limit-mismatch',
    })
  })
})

describe('consumeRateLimitWithFallback', () => {
  it('spends the request against the native binding, keyed the same way', async () => {
    const native = makeNative([true])
    const store = makeStore()

    const verdict = await consumeRateLimitWithFallback(
      { resolve: () => native, store },
      { ...MATCHED, key: 'auth:1.2.3.4' },
    )

    expect(verdict.backend).toBe('native')
    expect(verdict.allowed).toBe(true)
    expect(native.keys).toEqual(['auth:1.2.3.4'])
    // Nothing was written to KV — the two backends do not double-count.
    expect(store.size()).toBe(0)
  })

  it('reports remaining as unknown when the binding allows, and 0 when it blocks', async () => {
    // The binding answers `{ success }` and nothing else. `null` is what makes
    // rateLimit() omit X-RateLimit-Remaining rather than invent a number for it;
    // 0 on a block is the one count the boolean does tell us.
    const native = makeNative([true, false])
    const store = makeStore()
    const opts = { ...MATCHED, key: 'auth:1.2.3.4' }

    expect(
      (await consumeRateLimitWithFallback({ resolve: () => native, store }, opts)).remaining,
    ).toBeNull()

    const blocked = await consumeRateLimitWithFallback({ resolve: () => native, store }, opts)
    expect(blocked).toMatchObject({ allowed: false, remaining: 0 })
    // No reset clock is exposed, so Retry-After is the whole period: an upper
    // bound, which is the safe direction to be wrong in.
    expect(blocked.resetSeconds).toBe(DECLARED.windowSeconds)
  })

  it('gives the KV path results identical to calling consumeRateLimit directly', async () => {
    const opts = { key: 'mcp:user_1', limit: 3, windowSeconds: 300 }
    const now = 1_000_000_035_000

    const direct = makeStore()
    const viaFallback = makeStore()

    for (let i = 0; i < 4; i++) {
      const a = await consumeRateLimit(direct, opts, now)
      const b = await consumeRateLimitWithFallback(
        { resolve: () => makeNative([]), store: viaFallback },
        opts,
        now,
      )
      expect(b).toMatchObject({ ...a, backend: 'kv', reason: 'window-mismatch' })
    }
  })

  it('fails open when the binding throws', async () => {
    // An outage in the abuse-control layer must not take the product down. It
    // also must not quietly fall through to KV: one broken backend paying two
    // backends' latency is worse, and a binding that never gets used is a
    // binding whose breakage nobody notices.
    const store = makeStore()

    const verdict = await consumeRateLimitWithFallback(
      { resolve: () => THROWING_NATIVE, store },
      { ...MATCHED, key: 'auth:1.2.3.4' },
    )

    expect(verdict).toMatchObject({ allowed: true, backend: 'unavailable', remaining: null })
    expect(verdict.error).toContain('binding exploded')
    expect(store.size()).toBe(0)
  })

  it('fails open when the KV store throws', async () => {
    const exploding: RateLimitStore = {
      get: async () => {
        throw new Error('kv is not defined')
      },
      set: async () => undefined,
    }

    const verdict = await consumeRateLimitWithFallback({ store: exploding }, OPTS)
    expect(verdict).toMatchObject({ allowed: true, backend: 'unavailable' })
  })
})

describe('the deployed bindings', () => {
  // vitest.config.ts points the workers pool at the real wrangler.toml, so
  // `env` here holds the same bindings production gets. These facts cannot be
  // asserted from the TypeScript side alone, and both fail silently in
  // production: a missing binding means every call site on that budget quietly
  // uses KV, and a limit that no longer matches its NATIVE_LIMITERS entry means
  // the same thing.

  it.each(NATIVE_LIMITERS)('declares $binding, and it exists under that name', ({ binding }) => {
    const found = (env as unknown as Record<string, unknown>)[binding]
    expect(found, `no [[ratelimits]] block named ${binding} in wrangler.toml`).toBeDefined()
    expect(typeof (found as NativeRateLimiter | undefined)?.limit).toBe('function')
  })

  it.each(NATIVE_LIMITERS)(
    '$binding enforces exactly the $limit it claims',
    async ({ binding, limit }) => {
      const limiter = (env as unknown as Record<string, NativeRateLimiter>)[binding]!
      // Unique per run: the binding's counters are keyed globally within the
      // miniflare instance and outlive an individual `it`.
      const key = `drift-check:${crypto.randomUUID()}`

      for (let i = 0; i < limit; i++) {
        expect(
          (await limiter.limit({ key })).success,
          `request ${i + 1} was refused, so wrangler.toml permits fewer than ${limit}`,
        ).toBe(true)
      }

      expect(
        (await limiter.limit({ key })).success,
        `request ${limit + 1} was allowed — ${binding}'s simple.limit is higher than the ` +
          'NATIVE_LIMITERS entry, so the native path is enforcing a number nobody wrote down',
      ).toBe(false)
    },
  )
})
