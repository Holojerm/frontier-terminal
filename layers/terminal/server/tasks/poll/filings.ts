// Cron task: the filings lane, six-hourly at :47 (layers/terminal/server/pipeline/scopes.ts ›
// REGISTRATION_PREFIXES). Same wiring and the same reasons as poll/edgar.ts.
//
// Its own invocation because its own memory: each S-1 and amendment runs to
// ~14 MB, and with a third one in it the survey would carry ~124 MiB of the
// 128 MB that killed it on 2026-11-04 (payload-budget.test.ts).

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import sourcesYaml from 'raw:~~/sources.yaml'

import { createFetcher } from '../../pipeline/fetch'
import { unstorageLockStore } from '../../pipeline/lock'
import { blobRawStore, runPoll } from '../../pipeline/poll'
import { paceSec } from '../../pipeline/sec-pace'
import { warmAfterPoll } from '../../utils/cache-warm-task'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'poll:filings',
    description: 'Fetch the registration filings (S-1 indexes and prospectuses); diff and store',
  },
  async run({ context }) {
    const config = useRuntimeConfig()
    const result = await runPoll('filings', {
      db,
      raw: blobRawStore(blob),
      lock: unstorageLockStore(kv),
      fetcher: paceSec(
        createFetcher({
          secContactEmail: config.secContactEmail,
          appUrl: config.public.appUrl,
        }),
      ),
      sourcesYaml,
    })
    await warmAfterPoll(context)
    return { result }
  },
})

export default withHeartbeat(task)
