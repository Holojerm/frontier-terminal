// Warm the dev server before either browser suite measures anything.
//
// `nuxt dev` answers Playwright's webServer health check by server-rendering
// one page. The client bundle is a separate, much larger job: Vite transforms
// the component graph on demand when a browser first asks for it.
//
// The symptom was the first `page.goto` of a run — whichever test won the race
// — blowing through Playwright's 30s default while every later navigation took
// two seconds. Raising the per-test timeout for everyone was the wrong fix: it
// triples what a genuine hang costs in each of eighteen tests and blunts the
// one signal that timeout exists to give. Paying the build cost once, here,
// leaves every test on the default budget.
//
// ── Why globalSetup rather than a warmup project ────────────────────────────
// This runs after `webServer` (Playwright starts webServer as a plugin, and
// plugin setup precedes globalSetup), so the server is up by the time it
// navigates. A project would work too, but it would report a test with nothing
// to assert, and every suite would need a `dependencies` entry — one more thing
// to remember when adding the next one.
//
// A real browser rather than `fetch`: fetching the HTML only warms the SSR
// path, and the expensive half is the module graph a browser requests.

import { chromium } from '@playwright/test'
import type { FullConfig } from '@playwright/test'

/**
 * One path per page file the suites visit. Vite compiles each page's own
 * components on its first request, so warming only the shell left the lab,
 * tear-sheet, compare and thesis pages cold; on the two-core ubuntu-latest
 * runner their first visit ran past 30s, and which of them failed changed
 * from run to run with the parallel race. A page file added to the suites
 * belongs here too.
 */
const WARM_PATHS = [
  '/',
  '/prices',
  '/labs/openai',
  '/labs/openai/tear-sheet',
  '/compare/openai-vs-anthropic',
  '/theses',
  '/theses/anthropic',
  '/alerts',
  '/hiring',
  '/revenue',
  '/exposure',
  '/incidents',
  '/releases',
  '/rankings',
  '/compute',
  '/disclosures',
  '/data',
  '/about',
]

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL
  if (!baseURL) return

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ baseURL })
    const started = Date.now()
    for (const path of WARM_PATHS) {
      // A slow or non-2xx page is not fatal: this is a performance measure, and
      // the suites report a broken route with its name and a proper diff. A page
      // that never loads is: every test behind it would burn its own 30s timeout and report the
      // server's failure as dozens of unrelated ones. The first path pays for the shared graph;
      // the rest only for their own components, so a shorter cap keeps a hung page from eating
      // the job's 20 minutes.
      const timeout = path === WARM_PATHS[0] ? 240_000 : 60_000
      const response = await page
        .goto(path, { timeout, waitUntil: 'networkidle' })
        .catch((error: unknown) => {
          throw new Error(
            `warm-up: ${path} did not load in ${timeout / 1000}s — is the dev server up?`,
            {
              cause: error,
            },
          )
        })
      if (!response?.ok()) {
        console.warn(`warm-up: ${path} answered ${response?.status()} — drop it from WARM_PATHS`)
      }
    }
    console.info(
      `warmed ${WARM_PATHS.length} pages in ${Math.round((Date.now() - started) / 1000)}s`,
    )
  } finally {
    await browser.close()
  }
}
