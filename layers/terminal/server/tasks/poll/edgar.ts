// Cron task: poll the EDGAR feeds and the model catalogs every 30 minutes
// (layers/terminal/server/pipeline/scopes.ts).
//
// Scheduled from nuxt.config.ts (SCHEDULED_TASKS) and matched by the
// [triggers] crons entry in wrangler.toml; `bun run crons:check` fails the
// build when the two disagree. Imports are explicit, as in ops/alert.ts: a
// task is an untested bundling surface that runs unattended.
//
// sources.yaml arrives as text through Nitro's `raw:` import — there is no
// filesystem in a Worker, and the whitelist must come from the audited file,
// never from a number typed into code (parsers/sec/whitelist.ts).

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import sourcesYaml from 'raw:~~/sources.yaml'

import { recordOpsEvent } from '#server/utils/ops'
import { filedFactsSkip, runFiledFacts } from '../../exposure/ingest'
import { createFetcher } from '../../pipeline/fetch'
import { unstorageLockStore } from '../../pipeline/lock'
import { blobRawStore, runPoll } from '../../pipeline/poll'
import { paceSec } from '../../pipeline/sec-pace'
import { warmAfterPoll } from '../../utils/cache-warm-task'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'poll:edgar',
    description:
      'Fetch the EDGAR feeds and the model catalogs (launch detection); diff and store; read the hyperscaler filed facts',
  },
  async run({ context }) {
    const config = useRuntimeConfig()
    // One paced fetcher for the tick, so the SEC spacing counts the poll's
    // feeds and the filed facts together (pipeline/sec-pace.ts).
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
    // The hyperscaler filed facts (layers/terminal/server/exposure/) run after
    // a poll that ran, and not at all when it yielded to the survey or found
    // the lock held: two invocations fetching SEC at once broke its 10/s limit
    // on 2026-11-04 (18 instance reads answered 429 at 18:01). A failure is
    // spooled, never thrown over the poll.
    const skip = filedFactsSkip(result, fetcher.secRateLimited !== null)
    if (skip) console.warn(JSON.stringify({ kind: 'filed_facts_skipped', reason: skip }))
    const filedFacts = skip
      ? null
      : await runFiledFacts(db, {
          raw: blobRawStore(blob),
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
