// Fill the browser suites' store from the committed fixtures: the pipeline dev:fixtures
// runs (layers/terminal/server/dev/fixture-fill.ts), offline, against the local D1 and
// R2 that `wrangler dev` then serves from. Run by start.ts before the server boots.
//
// Without rows every page renders its empty state and axe checks gaps, not tables: 126
// target-size failures on source links sat on five public pages, invisible to the gate,
// until a run had real rows. A failure here fails the run for the same reason.
//
// Run with `--tsconfig-override=.nuxt/tsconfig.server.json`, which resolves the layer's
// `#server` and `#shared` imports.

import { readFile } from 'node:fs/promises'

import { drizzle } from 'drizzle-orm/d1'
import { getPlatformProxy } from 'wrangler'

import { fillFromFixtures } from '../../layers/terminal/server/dev/fixture-fill'
import type { LockStore } from '../../layers/terminal/server/pipeline/lock'
import * as schema from '../../server/db/schema'

const store = process.argv[2]
if (!store) throw new Error('usage: fill.ts <store dir>')

// wrangler's --persist-to puts its state under v3/; getPlatformProxy takes that dir itself.
const { env, dispose } = await getPlatformProxy<{ DB: D1Database; BLOB: R2Bucket }>({
  configPath: '.output/server/wrangler.json',
  persist: { path: `${store}/v3` },
})

// The fill is the only writer, so the survey lock needs no store behind it.
let held: string | null = null
const lock: LockStore = {
  get: async () => held,
  put: async (_key, value) => {
    held = value
  },
  delete: async () => {
    held = null
  },
}

try {
  const report = await fillFromFixtures({
    db: drizzle(env.DB, { schema }),
    raw: {
      put: async (key, body, contentType) => {
        await env.BLOB.put(key, body, { httpMetadata: { contentType } })
      },
    },
    readRaw: async (key) => (await env.BLOB.get(key))?.text() ?? null,
    lock,
    sourcesYaml: await readFile('sources.yaml', 'utf8'),
    read: (path) => readFile(path, 'utf8'),
  })
  const skipped = report.polls.filter((p) => p.status !== 'ran')
  if (skipped.length) throw new Error(`fixture fill: ${skipped.length} polls did not run`)
} finally {
  await dispose()
}
