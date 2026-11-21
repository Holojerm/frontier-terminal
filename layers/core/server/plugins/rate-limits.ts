// Declares the terminal's extra native rate-limit budgets to core. Registered
// here rather than by editing server/utils/rate-limit.ts, so that file stays the
// template's; the matching `[[ratelimits]]` blocks are in wrangler.toml.

export default defineNitroPlugin(() => {
  registerNativeLimiter(READ_PATH_LIMITER)
  for (const spec of Object.values(KEYED_READ_LIMITERS)) registerNativeLimiter(spec)
})
