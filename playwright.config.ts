// Playwright config — the suites that need a real browser. Application logic is
// tested by Vitest in the `workerd` pool (see vitest.config.ts); those two
// runners don't overlap, which is why the specs here are named *.spec.ts while
// Vitest owns *.test.ts (its `include` globs only `*.test.ts`).
//
// Two suites live here, and both are here for the same reason — the thing they
// check does not exist until a browser renders the page:
//
//   test/a11y/  axe. The rules that matter most — color-contrast above all —
//               are computed from resolved styles and actual layout, and jsdom
//               reports them as "incomplete" rather than pass or fail.
//   test/csp/   the Content-Security-Policy in nuxt.config.ts. A CSP only
//               exists as browser behaviour; nothing short of a real engine can
//               tell you whether the policy you shipped blocks your own app.
//
// They are separate `projects` rather than one directory so each keeps its own
// scope and shows up under its own name in the report — but they deliberately
// share the single `webServer` below, because booting one dev server twice is
// the slowest thing in `bun run ci`.

import { rmSync } from 'node:fs'

import { defineConfig, devices } from '@playwright/test'

import { playwrightPort } from './scripts/worktree-port'

// Derived from the checkout path rather than fixed at 3000, so parallel git
// worktrees each get their own server. See scripts/worktree-port.ts for why a
// hash beats both a fixed port and a free-port scan. Override with A11Y_PORT.
const PORT = playwrightPort()
const HOST = `http://localhost:${PORT}`

// Printed because the port is derived rather than known: without this the only
// way to open the app while a run is in flight is to recompute the hash.
// Playwright re-imports this config in every worker process, so print only from
// the runner — otherwise the line repeats once per worker in the CI log.
if (process.env.TEST_WORKER_INDEX === undefined) console.info(`browser suites → ${HOST}`)

// The suites' own NuxtHub data dir: test/warmup/fill-store.ts fills it from
// fixtures, which would rewrite a dev DB filled from a live poll. Wiped once per
// run (by the runner, not each worker) so every run starts from the same store.
const HUB_DIR = '.data-browser'
if (process.env.TEST_WORKER_INDEX === undefined) rmSync(HUB_DIR, { recursive: true, force: true })

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  // A failing contrast ratio is deterministic, so a real failure fails twice. One
  // CI retry is for the harness: the suite runs on a merge-queue batch of up to
  // three PRs, and one cold-compile timeout on `nuxt dev` used to eject all
  // three. A test that passes on retry is reported as flaky in the list output,
  // with its first-attempt trace kept, so flake stays visible.
  retries: process.env.CI ? 1 : 0,
  // Deliberately NOT raising the 30s default. The first navigation of a run
  // does blow through it on a cold Vite cache, but paying for that with a
  // bigger budget everywhere makes a genuine hang cost three times as long in
  // every one of eighteen tests, and blunts the one signal this timeout exists
  // to give. `globalSetup` absorbs the cold build once instead.
  fullyParallel: true,
  // One worker on CI. The ubuntu-latest runner this repo gets has 5 GB, and
  // once the store holds fixture rows (test/warmup/fill-store.ts) two workers
  // rendering /prices at once (two Chromium tabs, ~1.4 MB of HTML each, plus
  // the dev server's ~1.8 GB) reached 4.9 GB and the kernel killed the server
  // mid-run. Measured in CI with free/ps sampling on 2026-11-07.
  workers: process.env.CI ? 1 : undefined,
  // Runs after `webServer` (Playwright starts that as a plugin, and plugin
  // setup precedes globalSetup), so the server is reachable by then. Warms the
  // client bundle with a real page (test/warmup/) so the first test does not
  // pay for the cold Vite build.
  globalSetup: ['./test/warmup/fill-store.ts', './test/warmup/global-setup.ts'],
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: HOST,
    // Only kept for failures, so a green run leaves nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // No `dependencies` on any of these. Warming the dev server's first client
  // build used to be a `warmup` project every other project depended on; it is
  // `globalSetup` now, which happens once for the whole run and needs nothing
  // declared per project — including by the next project someone adds.
  projects: [
    { name: 'a11y', testDir: './test/a11y', use: { ...devices['Desktop Chrome'] } },
    { name: 'csp', testDir: './test/csp', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    // The dev server rather than the built Worker: `wrangler dev` on .output
    // would need bindings and migrations wired up just to render static
    // marketing pages, and the markup axe sees is the same either way.
    command: 'bun run dev:app',
    url: HOST,
    // Never reuse: this suite only produces valid results against a server
    // started with NUXT_DEVTOOLS=false, and a dev server already on this port
    // was almost certainly started without it. Reusing one silently reports
    // the devtools panel's own markup as this app's violations.
    //
    // This is also why the port above is per-checkout. `false` means a second
    // worktree running the suite does not share the first one's server, it
    // fails to boot — correct, and fatal for parallel agents until each
    // checkout got a port of its own.
    reuseExistingServer: false,
    // CI is always a cold cache, and a cold `nuxt dev` builds the whole app
    // before it listens. 120s was not enough — it timed out on the first run
    // after a merge that touched nuxt.config.ts, while the next warm boot took
    // 2s. Budget for the cold path, not the one you see locally.
    timeout: 300_000,
    // NUXT_TYPECHECK=false keeps vue-tsc off the critical path; `bun run ci`
    // has already typechecked before this suite runs. NUXT_PORT is what makes
    // `nuxt dev` listen on the derived port instead of its own default 3000.
    env: {
      NUXT_DEVTOOLS: 'false',
      NUXT_TYPECHECK: 'false',
      NUXT_PORT: String(PORT),
      NUXT_HUB_DIR: HUB_DIR,
    },
  },
})
