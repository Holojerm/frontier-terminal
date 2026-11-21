// Cron task: the hardware prints, hourly at :41 (layers/compute/server/prints/ingest.ts).
// Taiwan's revenue lands in a month's first ten days, TSMC's 6-K within hours, and
// KCS at 09:00 KST on the 1st, 11th, about the 15th and 21st, so an hourly read
// puts first_seen_at within the hour. KCS comes through the Mac mini's relay (core
// pipeline/relay.ts), one page a run: about four hours. EDGAR requests go through
// the SEC pacer.

import { paceSec } from '#layers/core/server/pipeline/sec-pace'
import { runPrintReads } from '../../prints/ingest'

const task = defineTask({
  meta: {
    name: 'prints:read',
    description:
      'Read the Taiwan monthly revenue feeds, TSMC’s revenue 6-Ks, Korea Customs Service’s export releases and UN Comtrade’s Korea HS 8542 months; store new figures',
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
