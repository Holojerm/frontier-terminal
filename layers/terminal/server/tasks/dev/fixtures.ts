// Dev-only task: fill the store from the committed fixtures instead of the
// network. The same pipeline a cron tick runs (runPoll, then the recipes, then
// the theses), with a fetcher that answers each source from fixtures/ by URL,
// so every page renders real-shaped rows offline and the same way every time.
//
// Two callers: `bun run dev:poll --fixtures` on a running dev server, and the
// browser suites' global setup, which runs it before the axe sweep so the
// sweep reads tables and footers rather than empty states. (An empty store hid
// 126 target-size failures there.)
//
// Never scheduled, and a no-op outside `nuxt dev`: /_nitro/tasks is only served
// in dev, and the body reads fixtures/ from the working directory, which a
// Worker does not have.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import sourcesYaml from 'raw:~~/sources.yaml'

import type { FetchOutcome, SourceFetcher } from '../../pipeline/fetch'
import { unstorageLockStore } from '../../pipeline/lock'
import { manifestFixtures } from '../../pipeline/parsers/fixture-provenance'
import { blobRawStore, runPoll } from '../../pipeline/poll'
import { evaluateTheses } from '../../theses/evaluate'
import { runRecipes } from '../../theses/recipes/run'
import { withHeartbeat } from '../../utils/task-heartbeat'

/** A source with no committed fixture answers like a 404: the run records it as absent. */
const NO_FIXTURE: FetchOutcome = { ok: false, status: 404, detail: 'no fixture for this URL' }

async function fixtureFetcher(): Promise<SourceFetcher> {
  const { readFile } = await import('node:fs/promises')
  const byUrl = new Map<string, string>()
  for (const f of manifestFixtures) byUrl.set(f.source_url, await readFile(f.path, 'utf-8'))
  return async (source) => {
    const text = byUrl.get(source.url)
    return text === undefined ? NO_FIXTURE : { ok: true, status: 200, text, bytes: text.length }
  }
}

const task = defineTask({
  meta: {
    name: 'dev:fixtures',
    description: 'Dev only: run the poll, recipes and theses over the committed fixtures',
  },
  async run() {
    if (!import.meta.dev) return { result: 'skipped: dev only' }
    const fetcher = await fixtureFetcher()
    const raw = blobRawStore(blob)
    const lock = unstorageLockStore(kv)
    const polls = []
    for (const scope of ['survey', 'careers'] as const) {
      polls.push(await runPoll(scope, { db, raw, lock, fetcher, sourcesYaml }))
    }
    const recipes = await runRecipes(db, { raw, fetcher, now: () => new Date() })
    const theses = await evaluateTheses(db, { sourcesYaml, now: () => new Date() })
    return { result: { polls, recipes: recipes.length, theses } }
  },
})

// Wrapped like every task (layers/terminal/test/freshness.test.ts); locally it only writes a heartbeat row.
export default withHeartbeat(task)
