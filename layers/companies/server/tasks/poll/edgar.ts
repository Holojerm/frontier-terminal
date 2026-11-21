// Cron task: poll the EDGAR feeds and the model catalogs every 30 minutes
// (layers/core/server/pipeline/scopes.ts). Imports are explicit, as in ops/watch.ts.
// sources.yaml comes in through Nitro's `raw:` import: a Worker has no filesystem,
// and the whitelist must come from the audited file (parsers/sec/whitelist.ts).

import sourcesYaml from 'raw:~~/sources.yaml'

import { filedFactsSkip, runFiledFacts } from '../../exposure/ingest'
import { runPoll } from '#layers/core/server/pipeline/poll'
import { paceSec } from '#layers/core/server/pipeline/sec-pace'

const task = defineTask({
  meta: {
    name: 'poll:edgar',
    description:
      'Fetch the EDGAR feeds and the model catalogs (launch detection); diff and store; read the hyperscaler filed facts',
  },
  async run({ context }) {
    const config = useRuntimeConfig()
    // One paced fetcher for the tick, so the SEC spacing counts the poll's
    // feeds and the filed facts together (layers/core/server/pipeline/sec-pace.ts).
    const fetcher = paceSec(
      createFetcher({
        secContactEmail: config.secContactEmail,
        appUrl: config.public.appUrl,
      }),
    )
    const result = await runPoll('edgar', {
      db,
      raw: blobRawStore(blob),
      lock: unstorageLockStore(kv),
      fetcher,
      sourcesYaml,
    })
    // The filed facts (layers/companies/server/exposure/) run only after a poll that
    // ran: two invocations fetching SEC at once break its 10/s limit. A failure is
    // spooled, never thrown over the poll.
    const skip = filedFactsSkip(result, fetcher.secRateLimited !== null)
    if (skip) console.warn(JSON.stringify({ kind: 'filed_facts_skipped', reason: skip }))
    const filedFacts = skip
      ? null
      : await runFiledFacts(db, {
          raw: blobRawStore(blob),
          readRaw: blobRawReader(blob),
          fetcher,
          now: new Date(),
          sourcesYaml,
        }).catch(async (error: unknown) => {
          await recordOpsEvent(db, { kind: 'filed_facts_run_failed', detail: String(error) })
          return null
        })
    await warmAfterPoll(context)
    return { result, filedFacts }
  },
})

export default withHeartbeat(task)
