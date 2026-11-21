// Applies the real Drizzle migrations to each test file's isolated D1 before
// its tests run. The migration list is injected as env.TEST_MIGRATIONS by
// vitest.config.ts (readD1Migrations reads server/db/migrations at config time,
// in Node, since workerd has no filesystem).
//
// NuxtHub's auto-imported `db`, `kv` and `blob` find their bindings on
// globalThis.__env__, which Nitro's Cloudflare handler sets before every
// invocation. Setting it here points them at this file's isolated bindings.

import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

Object.assign(globalThis, { __env__: env })

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
