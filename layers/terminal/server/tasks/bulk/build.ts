// Cron task: rebuild the bulk feed's files in R2 (layers/terminal/server/utils/terminal-bulk.ts).
// Hourly at :41, so it never shares an invocation with the survey (:00) or the
// careers lane (:17). A run builds only what isn't built yet today, so most
// hours it reads the index and stops. A file that fails is spooled for the ops
// digest and retried next hour, after everything else, with yesterday's copy
// still served.
//
// The licensed bucket arrives on the env Nitro hands a scheduled task
// (server/utils/ops-mail.ts says why that beats `cloudflare:workers`). Without
// the binding the build still runs and keeps the `full` files in the blob store.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import { recordOpsEvent } from '#server/utils/ops'
import { licensedStoreOf, runBulkBuild } from '../../utils/terminal-bulk'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'bulk:build',
    description:
      'Write each export table as a gzipped CSV and a Parquet file to R2 for the bulk feed, once a day',
  },
  async run({ context }) {
    const cloudflare = (context as { cloudflare?: { env?: unknown } } | undefined)?.cloudflare
    const report = await runBulkBuild({
      db,
      store: blob,
      licensed: licensedStoreOf(cloudflare?.env),
      appUrl: useRuntimeConfig().public.appUrl.replace(/\/+$/, ''),
    })
    for (const { file, error } of report.failed) {
      await recordOpsEvent(db, { kind: 'bulk_build_failed', detail: `${file}: ${error}` })
    }
    return { result: report }
  },
})

export default withHeartbeat(task)
