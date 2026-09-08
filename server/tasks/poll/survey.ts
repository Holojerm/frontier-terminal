// Cron task: poll every include source every six hours (server/pipeline/scopes.ts).
// Same wiring and the same reasons as poll/edgar.ts.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import sourcesYaml from 'raw:../../../sources.yaml'

import { createFetcher } from '../../pipeline/fetch'
import { unstorageLockStore } from '../../pipeline/lock'
import { blobRawStore, runPoll } from '../../pipeline/poll'

export default defineTask({
  meta: {
    name: 'poll:survey',
    description: 'Fetch every include source (pricing, hiring, EDGAR); diff and store',
  },
  async run() {
    const config = useRuntimeConfig()
    const result = await runPoll('survey', {
      db,
      raw: blobRawStore(blob),
      lock: unstorageLockStore(kv),
      fetcher: createFetcher({
        secContactEmail: config.secContactEmail,
        appUrl: config.public.appUrl,
      }),
      sourcesYaml,
    })
    return { result }
  },
})
