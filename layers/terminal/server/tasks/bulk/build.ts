// Cron task: rebuild the bulk feed's files in R2 (layers/terminal/server/utils/terminal-bulk.ts).
// Hourly at :41, so it never shares an invocation with the survey (:00) or the
// careers lane (:17). A run builds only what isn't built yet today, so most
// hours it reads the index and stops. A file that fails is spooled for the ops
// digest and retried next hour, with yesterday's copy still served.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import { recordOpsEvent } from '#server/utils/ops'
import { runBulkBuild } from '../../utils/terminal-bulk'

export default defineTask({
  meta: {
    name: 'bulk:build',
    description: 'Write each export table as a gzipped CSV to R2 for the bulk feed, once a day',
  },
  async run() {
    const report = await runBulkBuild({ db, store: blob })
    for (const { file, error } of report.failed) {
      await recordOpsEvent(db, { kind: 'bulk_build_failed', detail: `${file}: ${error}` })
    }
    return { result: report }
  },
})
