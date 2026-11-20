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
// share the single `webServer` below, because building and filling the server
// twice is the slowest part of a run.

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

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  // A failing contrast ratio is deterministic, so a real failure fails twice. One
  // CI retry is for the harness: the suite runs on a merge-queue batch of up to
  // three PRs, and one harness hiccup should not eject all three. A test that
  // passes on retry is reported as flaky in the list output, with its
  // retry's trace kept, so flake stays visible.
  retries: process.env.CI ? 1 : 0,
  // The 30s default. The server is a build, so no first visit waits on a compile,
  // and a bigger budget would only make a genuine hang cost more in every test.
  fullyParallel: true,
  // One worker on CI: the merge-queue VM has 3 CPUs and 5 GB. Two workers OOM'd the
  // old `nuxt dev` server there (2026-11-07). The built server leaves the room, but one
  // worker already fits the job's budget and the axe pass on /prices is the peak.
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: HOST,
    // Recorded on the CI retry only. `retain-on-failure` records every test and
    // throws the trace away on a pass, holding DOM snapshots of 1.7 MB pages in
    // the worker. Locally, rerun a failure with `--trace on`.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'a11y', testDir: './test/a11y', use: { ...devices['Desktop Chrome'] } },
    { name: 'csp', testDir: './test/csp', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    // The production build under `wrangler dev`, on a store filled from fixtures
    // (test/server/start.ts says why it replaced `nuxt dev`). The CSP suite reads the
    // headers that ship, frame-src 'none' included.
    command: 'bun run test/server/start.ts',
    url: HOST,
    // Never reuse: a server already on this port was not started from this
    // build and this store, so its results would describe something else.
    //
    // This is also why the port above is per-checkout. `false` means a second
    // worktree running the suite does not share the first one's server, it
    // fails to boot — correct, and fatal for parallel agents until each
    // checkout got a port of its own.
    reuseExistingServer: false,
    // The build runs inside this budget: ~10s on the Mac mini, longer on the
    // 3-CPU VM, plus the fill and wrangler's boot.
    timeout: 300_000,
    env: {
      BROWSER_SUITE_PORT: String(PORT),
      // Its own store, wiped by start.ts every run, so a run never touches the dev
      // server's .data and every run starts from the same rows.
      BROWSER_SUITE_STORE: '.data-browser',
    },
  },
})
