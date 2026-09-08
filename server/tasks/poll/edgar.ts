// Cron task: poll the two EDGAR feeds every 30 minutes (server/pipeline/scopes.ts).
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

import sourcesYaml from 'raw:../../../sources.yaml'

import { createFetcher } from '../../pipeline/fetch'
import { unstorageLockStore } from '../../pipeline/lock'
import { blobRawStore, runPoll } from '../../pipeline/poll'

export default defineTask({
  meta: {
    name: 'poll:edgar',
    description: 'Fetch the EDGAR full-text search and SPCX submissions feeds; diff and store',
  },
  async run() {
    const config = useRuntimeConfig()
    const result = await runPoll('edgar', {
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
