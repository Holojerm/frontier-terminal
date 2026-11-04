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
import { runFiledFacts } from '../../exposure/ingest'
import { createFetcher } from '../../pipeline/fetch'
import { unstorageLockStore } from '../../pipeline/lock'
import { blobRawStore, runPoll } from '../../pipeline/poll'
import { warmAfterPoll } from '../../utils/cache-warm-task'

export default defineTask({
  meta: {
    name: 'poll:edgar',
    description:
      'Fetch the EDGAR feeds and the model catalogs (launch detection); diff and store; read the hyperscaler filed facts',
  },
  async run({ context }) {
    const config = useRuntimeConfig()
    const fetcher = createFetcher({
      secContactEmail: config.secContactEmail,
      appUrl: config.public.appUrl,
    })
    const result = await runPoll('edgar', {
      db,
      raw: blobRawStore(blob),
      lock: unstorageLockStore(kv),
      fetcher,
      sourcesYaml,
    })
    // The hyperscaler filed facts (layers/terminal/server/exposure/) run on
    // every tick, the survey instant included, outside the poll lock: their
    // writes are append-only with deterministic ids, so an overlap stores
    // nothing twice. A failure is spooled, never thrown over the poll.
    const filedFacts = await runFiledFacts(db, {
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
