// Cron task: grid load where the lab sites are, six-hourly at :53. The
// EIA-930 six-month files (layers/terminal/server/power/grid-load.ts), read as
// a stream so the 30 to 47 MB body is never held, then ERCOT's large-load
// reports (power/ercot-large-loads.ts). Alone in its invocation: each file is
// a long download, and nothing else should wait behind it.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import { createFetcher, userAgentFor } from '../../pipeline/fetch'
import { runErcotLargeLoads } from '../../power/ercot-large-loads'
import { runGridLoad } from '../../power/grid-load'
import { recordOpsEvent } from '#server/utils/ops'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'power:grid-load',
    description:
      'Read EIA-930 demand for the lab sites’ balancing authorities, and ERCOT’s large-load reports',
  },
  async run() {
    const config = useRuntimeConfig()
    const options = { secContactEmail: config.secContactEmail, appUrl: config.public.appUrl }
    const userAgent = userAgentFor('https://www.eia.gov/', options)!
    const now = new Date()
    const eia = await runGridLoad(db, {
      put: async (key, body, contentType) => {
        await blob.put(key, body, { contentType })
      },
      userAgent,
      now,
    })
    const ercot = await runErcotLargeLoads(db, {
      fetcher: createFetcher(options),
      put: async (key, body, contentType) => {
        await blob.put(key, body, { contentType })
      },
      userAgent,
      now,
    }).catch(async (error: unknown) => {
      await recordOpsEvent(db, { kind: 'grid_load_read_failed', detail: `ERCOT: ${String(error)}` })
      return null
    })
    return { result: { eia, ercot } }
  },
})

export default withHeartbeat(task)
