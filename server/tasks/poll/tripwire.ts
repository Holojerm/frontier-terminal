// Cron task: the five-minute launch tripwire (server/pipeline/tripwire.ts).
// Same wiring and the same reasons as poll/edgar.ts.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import sourcesYaml from 'raw:../../../sources.yaml'

import { createFetcher } from '../../pipeline/fetch'
import { unstorageLockStore } from '../../pipeline/lock'
import { blobRawStore } from '../../pipeline/poll'
import { runTripwire } from '../../pipeline/tripwire'

export default defineTask({
  meta: {
    name: 'poll:tripwire',
    description:
      'Parse the four model catalogs; poll them off-cycle when they differ from the store',
  },
  async run() {
    const config = useRuntimeConfig()
    const result = await runTripwire({
      db,
      raw: blobRawStore(blob),
      lock: unstorageLockStore(kv),
      fetcher: createFetcher({
        secContactEmail: config.secContactEmail,
        appUrl: config.public.appUrl,
      }),
      sourcesYaml,
    })
    // Quiet ticks stay quiet; a trip is worth one line.
    if (result.status === 'tripped') {
      console.warn(
        JSON.stringify({
          kind: 'tripwire_tripped',
          by: result.by,
          ...('skipped' in result
            ? { skipped: result.skipped }
            : { failed: result.result.failed, sources: result.result.sources.length }),
        }),
      )
    }
    return { result }
  },
})
