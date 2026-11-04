// Cron task: the careers lane, six-hourly at :17 (layers/terminal/server/pipeline/scopes.ts ›
// CAREERS_SOURCES). Same wiring and the same reasons as poll/edgar.ts.
//
// Its own invocation because its own memory: Alphabet's careers feed is ~20 MB,
// and inside the survey it pushed the tick over the 128 MB limit, which killed
// every source the survey had not yet recorded.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import sourcesYaml from 'raw:~~/sources.yaml'

import { createFetcher } from '../../pipeline/fetch'
import { unstorageLockStore } from '../../pipeline/lock'
import { blobRawStore, runPoll } from '../../pipeline/poll'
import { warmAfterPoll } from '../../utils/cache-warm-task'

export default defineTask({
  meta: {
    name: 'poll:careers',
    description: 'Fetch the large careers feeds (Google, DeepMind roles only); diff and store',
  },
  async run({ context }) {
    const config = useRuntimeConfig()
    const result = await runPoll('careers', {
      db,
      raw: blobRawStore(blob),
      lock: unstorageLockStore(kv),
      fetcher: createFetcher({
        secContactEmail: config.secContactEmail,
        appUrl: config.public.appUrl,
      }),
      sourcesYaml,
    })
    await warmAfterPoll(context)
    return { result }
  },
})
