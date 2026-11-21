// Cron task: the five-minute launch tripwire (layers/models/server/pipeline/tripwire.ts).
// Same wiring and the same reasons as poll/edgar.ts.

import sourcesYaml from 'raw:~~/sources.yaml'

import { runTripwire } from '../../pipeline/tripwire'

const task = defineTask({
  meta: {
    name: 'poll:tripwire',
    description:
      'Parse each lab’s model catalog; poll them off-cycle when they differ from the store',
  },
  async run({ context }) {
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
    await warmAfterPoll(context)
    return { result }
  },
})

export default withHeartbeat(task)
