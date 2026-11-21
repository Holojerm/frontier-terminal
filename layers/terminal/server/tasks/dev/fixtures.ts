// Dev-only task: fill the store from the committed fixtures instead of the
// network. The same pipeline the crons run (the polls, the filed-facts
// reader, the recipes, the theses: dev/fixture-fill.ts), with a fetcher that
// answers each source from fixtures/ by URL, so every page renders
// real-shaped rows offline and the same way every time.
//
// Called by `bun run dev:poll --fixtures` on a running dev server. The browser
// suites run the same fill against the built Worker's store (test/server/fill.ts).
//
// Never scheduled, and a no-op outside `nuxt dev`: /_nitro/tasks is only served
// in dev, and the body reads fixtures/ from the working directory, which a
// Worker does not have.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import sourcesYaml from 'raw:~~/sources.yaml'

import { fillFromFixtures, type FixtureFillReport } from '../../dev/fixture-fill'
import { blobRawReader, blobRawStore } from '#layers/core/server/utils/pipeline-raw'
import { unstorageLockStore } from '#layers/core/server/utils/pipeline-lock'
import { withHeartbeat } from '#layers/core/server/utils/task-heartbeat'

const task = defineTask<string | FixtureFillReport>({
  meta: {
    name: 'dev:fixtures',
    description:
      'Dev only: run the polls, filed facts, recipes and theses over the committed fixtures',
  },
  async run() {
    if (!import.meta.dev) return { result: 'skipped: dev only' }
    const { readFile } = await import('node:fs/promises')
    const result = await fillFromFixtures({
      db,
      raw: blobRawStore(blob),
      readRaw: blobRawReader(blob),
      lock: unstorageLockStore(kv),
      sourcesYaml,
      read: (path) => readFile(path, 'utf-8'),
    })
    return { result }
  },
})

// Wrapped like every task (layers/terminal/test/freshness.test.ts); locally it only writes a heartbeat row.
export default withHeartbeat(task)
