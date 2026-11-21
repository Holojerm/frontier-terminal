// Cron task: grid load where the lab sites are, six-hourly at :53. EIA-930
// demand from EIA's API v2 when NUXT_EIA_API_KEY is set, and from the six-month
// files (read as a stream, so the 30 to 47 MB body is never held) for 2018 and
// whenever the API fails (layers/terminal/server/power/grid-load.ts), then ERCOT's large-load
// reports (power/ercot-large-loads.ts). Alone in its invocation: each file is
// a long download, and nothing else should wait behind it.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import { createFetcher, userAgentFor } from '#layers/core/server/pipeline/fetch'
import { runErcotLargeLoads } from '../../power/ercot-large-loads'
import { runGridLoad } from '../../power/grid-load'
import { recordOpsEvent } from '#server/utils/ops'
import { withHeartbeat } from '#layers/core/server/utils/task-heartbeat'

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
      apiKey: config.eiaApiKey,
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
