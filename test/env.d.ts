// Types for the bindings the test pool injects (vitest.config.ts).
// `cloudflare:test`'s `env` is typed as `Cloudflare.Env` since
// @cloudflare/vitest-plugin 1.0 (the old `ProvidedEnv` interface is gone).

import type { D1Migration } from '@cloudflare/vitest-plugin'

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      KV: KVNamespace
      BLOB: R2Bucket
      /** Migrations read from server/db/migrations, applied by test/setup.ts. */
      TEST_MIGRATIONS: D1Migration[]
      /** Serves the committed fixtures + sources.yaml as one JSON object keyed by
       * repo-relative path (vitest.config.ts); read it through pipeline/fixtures.ts. */
      FIXTURES: Fetcher
    }
  }
}
