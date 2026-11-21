// Playwright: the suites that need a real browser. Application logic is tested
// by Vitest in the `workerd` pool (see vitest.config.ts), so specs here are
// *.spec.ts while Vitest owns *.test.ts.
//
//   test/a11y/  axe. The rules that matter most (color contrast above all) need
//               resolved styles and layout; jsdom reports them as "incomplete".
//   test/csp/   the Content-Security-Policy in nuxt.config.ts, which only exists
//               as browser behaviour.
//
// Separate `projects` so each reports under its own name, sharing the one
// `webServer` below because building and filling the server is the slowest part
// of a run.

import { defineConfig, devices } from '@playwright/test'

import { playwrightPort } from './scripts/worktree-port'

// Derived from the checkout path, so parallel git worktrees each get their own
// server (scripts/worktree-port.ts says why a hash). Override with A11Y_PORT.
const PORT = playwrightPort()
const HOST = `http://localhost:${PORT}`

// Printed because the port is derived. Playwright re-imports this config in
// every worker process, so only the runner prints it.
if (process.env.TEST_WORKER_INDEX === undefined) console.info(`browser suites → ${HOST}`)

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  // A failing contrast ratio fails twice. One CI retry covers the harness: the
  // suite runs on a merge-queue batch of up to three PRs, and one hiccup
  // shouldn't eject all three. A pass on retry is reported as flaky, with its
  // trace kept.
  retries: process.env.CI ? 1 : 0,
  // The 30s default timeout: the server is a build, so no visit waits on a
  // compile, and a bigger budget only makes a hang cost more.
  fullyParallel: true,
  // One worker on CI: the merge-queue VM has 3 CPUs and 5 GB, one worker fits the
  // job's budget, and the axe pass on /prices is the peak.
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: HOST,
    // Recorded on the CI retry only: `retain-on-failure` records every test,
    // holding DOM snapshots of 1.7 MB pages in the worker. Locally, rerun a
    // failure with `--trace on`.
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
    // Never reuse: a server already on this port wasn't started from this build
    // and store. With `false`, a second worktree on the same port fails to boot,
    // hence the per-checkout port above.
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
