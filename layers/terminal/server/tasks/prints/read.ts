// Cron task: the hardware prints, hourly at :41 (layers/terminal/server/prints/ingest.ts).
// Taiwan's revenue lands over the first ten days of a month and TSMC's 6-K
// within hours of its release, and Korea Customs Service posts at 09:00 KST
// (00:00 UTC) on the 1st, 11th, about the 15th and 21st, so an hourly read
// puts first_seen_at within the hour of the source. EDGAR requests go
// through the SEC pacer.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import { createFetcher } from '../../pipeline/fetch'
import { blobRawStore } from '../../pipeline/poll'
import { paceSec } from '../../pipeline/sec-pace'
import { runPrintReads } from '../../prints/ingest'
import { withHeartbeat } from '../../utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'prints:read',
    description:
      'Read the Taiwan monthly revenue feeds, TSMC’s revenue 6-Ks and Korea Customs Service’s export releases; store new figures',
  },
  async run() {
    const config = useRuntimeConfig()
    const fetcher = paceSec(
      createFetcher({
        secContactEmail: config.secContactEmail,
        appUrl: config.public.appUrl,
      }),
    )
    const result = await runPrintReads(db, { raw: blobRawStore(blob), fetcher, now: new Date() })
    return { result }
  },
})

export default withHeartbeat(task)
