// Declares the terminal's extra native rate-limit budget to core. Registered
// here rather than by editing server/utils/rate-limit.ts, so that file stays the
// template's; the matching `[[ratelimits]]` block is in wrangler.toml.

import { registerNativeLimiter } from '#server/utils/rate-limit'

import { READ_PATH_LIMITER } from '../utils/rate-limits'

export default defineNitroPlugin(() => {
  registerNativeLimiter(READ_PATH_LIMITER)
})
