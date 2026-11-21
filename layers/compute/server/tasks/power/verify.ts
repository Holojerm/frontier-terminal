// Cron task: the weekly re-check of the power table's hand-read rows off
// EDGAR, Tuesday 05:29 UTC (layers/compute/server/power/verify.ts). Alone in
// its invocation: it fetches a page per utility, regulator or company the
// table cites, none of them SEC's.

import { db } from '@nuxthub/db'

import { createFetcher } from '#layers/core/server/utils/pipeline-fetch'
import { verifyHandTies } from '../../power/verify'
import { withHeartbeat } from '#layers/core/server/utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'power:verify',
    description: 'Re-read each utility, regulator and company page the power table cites',
  },
  async run() {
    const config = useRuntimeConfig()
    const fetcher = createFetcher({
      secContactEmail: config.secContactEmail,
      appUrl: config.public.appUrl,
    })
    const report = await verifyHandTies(db, { fetcher, now: new Date() })
    const count = (s: string) => report.checks.filter((c) => c.status === s).length
    return {
      result: {
        seeded: report.seeded,
        found: count('found'),
        gone: count('gone'),
        unread: report.checks.filter((c) => c.status === 'unread'),
      },
    }
  },
})

export default withHeartbeat(task)
