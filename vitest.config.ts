// Vitest config — uses @cloudflare/vitest-plugin so tests run inside the
// same `workerd` runtime that Cloudflare runs in production. Server-side code
// gets real D1, KV, and R2 bindings via the `cloudflare:test` import, with
// each test file getting its own isolated storage.
//
// Tests live in `test/` (alongside `app/`, `server/`). Co-located *.test.ts
// inside `server/` is also picked up.
//
// Docs: https://developers.cloudflare.com/workers/testing/vitest-integration/

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Every committed fixture (plus sources.yaml) keyed by repo-relative path, handed to
// the tests as a binding. Importing them with `?raw` made each test file transform and
// evaluate ~10 MB of strings in workerd (about 2 s per file, ~100 s across the suite).
function readFixtures(): Record<string, string> {
  const out: Record<string, string> = { 'sources.yaml': readFileSync('sources.yaml', 'utf8') }
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${e.name}`
      if (e.isDirectory()) walk(path)
      else if (e.name !== 'README.md') out[path] = readFileSync(path, 'utf8')
    }
  }
  walk('fixtures')
  return out
}

const migrationsPath = fileURLToPath(new URL('./server/db/migrations', import.meta.url))

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // The real migrations, handed to test/setup.ts (which applies them to
        // each test file's isolated D1) — so tests exercise the real tables
        // rather than a hand-written copy that drifts.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
          FIXTURES: readFixtures(),
        },
      },
    })),
  ],
  resolve: {
    alias: {
      // Match the `~` alias Nuxt sets up in app/server code, so test imports
      // like `import { ... } from '~/server/db/schema'` resolve correctly.
      '~': fileURLToPath(new URL('./', import.meta.url)),
      '~~': fileURLToPath(new URL('./', import.meta.url)),
      // Nuxt 4's shared/ alias. Server utils import through it rather than
      // relying on auto-imports, which typecheck everywhere but are not always
      // injected at runtime — see AGENTS.md › Gotchas.
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
      // Nuxt's alias for the app's server/ dir. Layer code reaches core utils
      // through it, so it resolves against whichever app the layer is in.
      '#server': fileURLToPath(new URL('./server', import.meta.url)),
      // Nuxt's `#layers/<name>` aliases, for the few core files that import a
      // fork-owned layer (fleet-status, the ops alert task, the sitemap route).
      '#layers': fileURLToPath(new URL('./layers', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'server/**/*.test.ts', 'layers/*/test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
})
