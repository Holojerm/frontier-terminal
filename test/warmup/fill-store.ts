// Fill the store from the committed fixtures before either browser suite runs.
//
// The suites boot `nuxt dev` on a fresh .data/db, so without this every page
// renders its empty state and axe checks gaps, not tables: 126 target-size
// failures on source links sat on five public pages, invisible to the gate,
// until a local run had real rows. dev:fixtures
// (layers/terminal/server/tasks/dev/fixtures.ts) runs the real pipeline over
// fixtures/, offline, so the data is the same on every run and every machine.
//
// A failure here fails the run: a sweep over empty pages would pass while
// checking far less than it claims to.

import type { FullConfig } from '@playwright/test'

export default async function fillStore(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL
  if (!baseURL) return
  const res = await fetch(`${baseURL}/_nitro/tasks/dev:fixtures`)
  if (!res.ok) {
    throw new Error(`dev:fixtures answered ${res.status}: ${(await res.text()).slice(0, 500)}`)
  }
  console.info('store filled from fixtures/')
}
