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
import Unimport from 'unimport/unplugin'
import { defineConfig } from 'vitest/config'

import { generatedImports } from './scripts/lib/auto-imports'

// Tests and the code under them get the auto-imports Nitro and the app get, read from the
// lists Nuxt generates. Nitro's own runtime helpers (useRuntimeConfig, defineTask,
// useStorage…) are left out: they import virtual modules that exist only in a Nitro build.
const ROOT = fileURLToPath(new URL('./', import.meta.url))
const APP_FILE = new RegExp(`^${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(layers/[^/]+/)?app/`)
const serverImports = generatedImports(ROOT, 'server').filter(
  (i) => !/^nitropack\/|\/node_modules\/@nuxt\/nitro-server\//.test(i.from),
)
const appImports = generatedImports(ROOT, 'app').filter(
  (i) => i.from === 'vue' || (i.from.startsWith(ROOT) && !i.from.includes('/node_modules/')),
)

// Every committed fixture (plus sources.yaml) keyed by repo-relative path, served to the
// tests by a Node-side service binding. Importing them with `?raw` made each test file
// transform and evaluate ~10 MB of strings in workerd (about 2 s per file). A plain JSON
// binding was copied into every file's worker at spawn, used or not: ~0.45 s per file,
// over a third of the suite's wall time at 13 MB. Only the files that import
// layers/core/test/pipeline/fixtures.ts fetch it now.
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

let fixturesJson: string | undefined
const serveFixtures = () =>
  new Response((fixturesJson ??= JSON.stringify(readFixtures())), {
    headers: { 'content-type': 'application/json' },
  })

export default defineConfig({
  plugins: [
    Unimport.vite({
      imports: serverImports,
      dts: false,
      include: [/\.ts$/],
      exclude: [/[\\/]node_modules[\\/]/, APP_FILE],
    }),
    Unimport.vite({
      imports: appImports,
      dts: false,
      include: [APP_FILE],
      exclude: [/[\\/]node_modules[\\/]/, /\.vue/, /\?raw$/],
    }),
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // The real migrations, handed to test/setup.ts (which applies them to
        // each test file's isolated D1) — so tests exercise the real tables
        // rather than a hand-written copy that drifts.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
        },
        serviceBindings: { FIXTURES: serveFixtures },
      },
    })),
  ],
  resolve: {
    alias: {
      // Match the `~` alias Nuxt sets up in app/server code, so test imports
      // like `import { ... } from '~/server/db/schema'` resolve correctly.
      '~': fileURLToPath(new URL('./', import.meta.url)),
      '~~': fileURLToPath(new URL('./', import.meta.url)),
      // Nuxt 4's shared/ alias, for the files that keep explicit imports.
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
